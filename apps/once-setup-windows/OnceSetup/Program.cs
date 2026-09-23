using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OnceSetup;

internal static class Program
{
    private static readonly Regex EvaluationKeyPattern = new(
        "^once_test_[A-Za-z0-9_-]{32,128}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    [STAThread]
    private static async Task Main()
    {
        ApplicationConfiguration.Initialize();

        try
        {
            var apiKey = Clipboard.GetText()?.Trim() ?? string.Empty;
            if (!EvaluationKeyPattern.IsMatch(apiKey))
            {
                MessageBox.Show(
                    "Once Setup could not find a valid evaluation API key on your clipboard.\n\nReturn to the Once evaluation page, click Copy API key, then open Once Setup again.",
                    "Once Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            if (!await VerifyApiKeyAsync(apiKey))
            {
                MessageBox.Show(
                    "The Once API key could not be verified.\n\nReturn to the evaluation page and create a fresh evaluation key.",
                    "Once Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            var node = FindOnPath("node.exe");
            var npm = FindOnPath("npm.cmd");
            if (node is null || npm is null)
            {
                var answer = MessageBox.Show(
                    "Once automatic setup needs Node.js 18 or newer, but Node.js was not found on this computer.\n\nOpen the official Node.js download page now?",
                    "Once Setup",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);

                if (answer == DialogResult.Yes)
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "https://nodejs.org/en/download",
                        UseShellExecute = true,
                    });
                }
                return;
            }

            var major = GetNodeMajorVersion(node);
            if (major < 18)
            {
                MessageBox.Show(
                    $"Once needs Node.js 18 or newer. This computer is using Node.js {major}.",
                    "Once Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            var mode = MessageBox.Show(
                "Where should Once be installed?\n\nYES — Create a safe Once demo project for me. Recommended for a first evaluation.\n\nNO — Let me choose an existing Node.js project.\n\nCANCEL — Exit without changing anything.",
                "Once Setup",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question);

            if (mode == DialogResult.Cancel)
            {
                return;
            }

            var isDemo = mode == DialogResult.Yes;
            var root = isDemo ? CreateDemoProject() : ChooseExistingProject();
            if (root is null)
            {
                return;
            }

            if (!ConfirmKeyReplacement(root, apiKey))
            {
                return;
            }

            var confirm = MessageBox.Show(
                "Once is ready to set up this folder:\n\n" + root +
                "\n\nOnce will:\n• install @once-agent/sdk\n• save your evaluation key to .env\n• add .env to .gitignore\n• verify the Once connection" +
                (isDemo ? "\n• run a safe retry-suppression demo" : string.Empty) +
                "\n\nIt will not modify your application source code.\n\nContinue?",
                "Once Setup",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (confirm != DialogResult.Yes)
            {
                return;
            }

            Cursor.Current = Cursors.WaitCursor;
            var install = RunProcess(
                "cmd.exe",
                $"/d /s /c \"\"{npm}\" install @once-agent/sdk\"",
                root,
                environment: null);

            if (install.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "The Once SDK installation did not complete successfully.\n\n" + install.Output);
            }

            SaveKey(root, apiKey);

            if (!await VerifyApiKeyAsync(apiKey))
            {
                throw new InvalidOperationException("The Once API connection could not be verified after installation.");
            }

            if (isDemo)
            {
                RunDemo(root, node, apiKey);
                MessageBox.Show(
                    "Once is installed and connected.\n\nThe demo also proved the safety behavior:\n\n✓ first action executed\n✓ retry was suppressed\n✓ side effects stayed at 1\n\nDemo folder:\n" + root,
                    "Once Setup complete",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            else
            {
                MessageBox.Show(
                    "Once is installed and connected to this project.\n\n✓ SDK installed\n✓ API key saved in .env\n✓ .env added to .gitignore\n✓ Once API connection verified\n\nNo application source files were changed.\n\nProject:\n" + root,
                    "Once Setup complete",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }

            Clipboard.Clear();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Once Setup stopped safely.\n\n" + ex.Message + "\n\nNo hidden retry or recovery action was attempted.",
                "Once Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
        finally
        {
            Cursor.Current = Cursors.Default;
        }
    }

    private static async Task<bool> VerifyApiKeyAsync(string apiKey)
    {
        var probe = "windows-setup-" + Guid.NewGuid().ToString("N");
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        using var response = await client.GetAsync($"https://api.onceexec.com/v1/truth/{probe}");
        if (!response.IsSuccessStatusCode)
        {
            return false;
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var json = await JsonDocument.ParseAsync(stream);
        var root = json.RootElement;

        return root.TryGetProperty("ledger_state", out var state)
            && state.GetString() == "ABSENT"
            && root.TryGetProperty("side_effects", out var sideEffects)
            && sideEffects.GetInt32() == 0;
    }

    private static string? FindOnPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim('"'), fileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // Ignore malformed PATH entries and continue searching.
            }
        }
        return null;
    }

    private static int GetNodeMajorVersion(string node)
    {
        var result = RunProcess(node, "-p \"process.versions.node\"", Environment.CurrentDirectory, null);
        var version = result.Output.Trim().Split('.', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return int.TryParse(version, out var major) ? major : 0;
    }

    private static string CreateDemoProject()
    {
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (string.IsNullOrWhiteSpace(documents))
        {
            documents = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        var basePath = Path.Combine(documents, "Once Evaluation Demo");
        var root = basePath;
        var suffix = 2;
        while (Directory.Exists(root))
        {
            root = basePath + " " + suffix++;
        }

        Directory.CreateDirectory(root);
        File.WriteAllText(
            Path.Combine(root, "package.json"),
            "{\n  \"name\": \"once-evaluation-demo\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n",
            new UTF8Encoding(false));
        return root;
    }

    private static string? ChooseExistingProject()
    {
        while (true)
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = "Choose the project folder that contains package.json",
                ShowNewFolderButton = false,
                UseDescriptionForTitle = true,
            };

            if (dialog.ShowDialog() != DialogResult.OK)
            {
                return null;
            }

            if (File.Exists(Path.Combine(dialog.SelectedPath, "package.json")))
            {
                return dialog.SelectedPath;
            }

            var retry = MessageBox.Show(
                "That folder does not contain package.json, so Once cannot safely identify it as a Node.js project.\n\nChoose another folder?",
                "Once Setup",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (retry != DialogResult.Yes)
            {
                return null;
            }
        }
    }

    private static bool ConfirmKeyReplacement(string root, string apiKey)
    {
        var envPath = Path.Combine(root, ".env");
        if (!File.Exists(envPath))
        {
            return true;
        }

        var text = File.ReadAllText(envPath);
        var match = Regex.Match(text, "(?m)^ONCE_API_KEY=(.*)$");
        if (!match.Success || match.Groups[1].Value.Trim() == apiKey)
        {
            return true;
        }

        return MessageBox.Show(
            "This project already has a different Once API key in .env.\n\nReplace it with this evaluation key?",
            "Once Setup",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
    }

    private static void SaveKey(string root, string apiKey)
    {
        var envPath = Path.Combine(root, ".env");
        var envText = File.Exists(envPath) ? File.ReadAllText(envPath) : string.Empty;
        if (Regex.IsMatch(envText, "(?m)^ONCE_API_KEY=.*$"))
        {
            envText = Regex.Replace(envText, "(?m)^ONCE_API_KEY=.*$", "ONCE_API_KEY=" + apiKey);
        }
        else
        {
            if (envText.Length > 0 && !envText.EndsWith(Environment.NewLine, StringComparison.Ordinal))
            {
                envText += Environment.NewLine;
            }
            envText += "ONCE_API_KEY=" + apiKey + Environment.NewLine;
        }
        File.WriteAllText(envPath, envText, new UTF8Encoding(false));

        var ignorePath = Path.Combine(root, ".gitignore");
        var ignoreText = File.Exists(ignorePath) ? File.ReadAllText(ignorePath) : string.Empty;
        var hasEnv = ignoreText
            .Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
            .Any(line => line.Trim() == ".env");

        if (!hasEnv)
        {
            if (ignoreText.Length > 0 && !ignoreText.EndsWith(Environment.NewLine, StringComparison.Ordinal))
            {
                ignoreText += Environment.NewLine;
            }
            ignoreText += ".env" + Environment.NewLine;
            File.WriteAllText(ignorePath, ignoreText, new UTF8Encoding(false));
        }
    }

    private static void RunDemo(string root, string node, string apiKey)
    {
        var demoPath = Path.Combine(root, "once-demo.mjs");
        const string demo = """
import { randomUUID } from "node:crypto";
import { Once } from "@once-agent/sdk";

const once = new Once({ baseUrl: "https://api.onceexec.com" });
const operationId = "installer-demo-" + randomUUID().replaceAll("-", "");
const action = { type: "once_evaluation_demo", source: "windows_setup_msix" };

const first = await once.execute({ operationId, provider: "blind_test", action });
const retry = await once.execute({ operationId, provider: "blind_test", action });

if (first.state !== "CONFIRMED" || Number(first.side_effects) !== 1) {
  throw new Error("first_execution_check_failed");
}

if (retry.result !== "already_executed" || Number(retry.side_effects) !== 1) {
  throw new Error("retry_suppression_check_failed");
}

console.log("ONCE_DEMO_PASS");
""";

        File.WriteAllText(demoPath, demo, new UTF8Encoding(false));
        var environment = new Dictionary<string, string> { ["ONCE_API_KEY"] = apiKey };
        var result = RunProcess(node, $"\"{demoPath}\"", root, environment);
        if (result.ExitCode != 0 || !result.Output.Contains("ONCE_DEMO_PASS", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The Once demo could not complete its retry-suppression check.\n\n" + result.Output);
        }
    }

    private static (int ExitCode, string Output) RunProcess(
        string fileName,
        string arguments,
        string workingDirectory,
        IReadOnlyDictionary<string, string>? environment)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        if (environment is not null)
        {
            foreach (var pair in environment)
            {
                psi.Environment[pair.Key] = pair.Value;
            }
        }

        using var process = Process.Start(psi) ?? throw new InvalidOperationException("Could not start setup process.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, (stdout + Environment.NewLine + stderr).Trim());
    }
}
