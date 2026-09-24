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
                using var prompt = new ApiKeyPrompt();
                if (prompt.ShowDialog() != DialogResult.OK)
                {
                    return;
                }
                apiKey = prompt.ApiKey;
            }

            if (!EvaluationKeyPattern.IsMatch(apiKey))
            {
                SetupDialogs.ShowWarning(
                    "INVALID API KEY",
                    "The key does not look like a Once evaluation key. Return to the evaluation page, click Copy API key, then try again.");
                return;
            }

            if (!await VerifyApiKeyAsync(apiKey))
            {
                SetupDialogs.ShowError(
                    "API KEY COULD NOT BE VERIFIED",
                    "Once could not verify this evaluation key. Return to the evaluation page and create a fresh evaluation key.");
                return;
            }

            var node = FindOnPath("node.exe");
            var npm = FindOnPath("npm.cmd");
            if (node is null || npm is null)
            {
                if (SetupDialogs.AskOpenNodeDownload())
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
                SetupDialogs.ShowWarning(
                    "NODE.JS UPDATE REQUIRED",
                    $"Once needs Node.js 18 or newer. This computer is using Node.js {major}.");
                return;
            }

            var mode = SetupDialogs.ChooseProjectMode();
            if (mode == ProjectMode.Cancel)
            {
                return;
            }

            var isDemo = mode == ProjectMode.Demo;
            var root = isDemo ? CreateDemoProject() : ChooseExistingProject();
            if (root is null)
            {
                return;
            }

            if (!ConfirmKeyReplacement(root, apiKey))
            {
                return;
            }

            if (!SetupDialogs.ConfirmSetup(root, isDemo))
            {
                return;
            }

            using var progress = new SetupProgressForm();
            progress.Show();
            progress.SetStage(0, "Checking Node.js and the selected project...");
            Application.DoEvents();

            progress.SetStage(1, "Installing @once-agent/sdk... The first install can take a little while.");
            var install = RunProcess(
                "cmd.exe",
                $"/d /s /c \"\"{npm}\" install @once-agent/sdk\"",
                root,
                environment: null);

            if (install.ExitCode != 0)
            {
                progress.Close();
                throw new InvalidOperationException(
                    "The Once SDK installation did not complete successfully.\n\n" + install.Output);
            }

            progress.SetStage(2, "Saving the evaluation key to .env and protecting it with .gitignore...");
            SaveKey(root, apiKey);

            progress.SetStage(3, "Verifying the Once API connection... This network check can take up to 15 seconds.");
            if (!await VerifyApiKeyAsync(apiKey))
            {
                progress.Close();
                throw new InvalidOperationException("The Once API connection could not be verified after installation.");
            }

            progress.SetStage(4, isDemo
                ? "Running the first-action and retry-suppression proof... This usually completes in a few seconds."
                : "Final verification complete. No application source files were changed.");

            if (isDemo)
            {
                RunDemo(root, node, apiKey);
            }

            progress.SetStage(5, isDemo
                ? "Safety behavior verified: duplicate execution was suppressed."
                : "Once is connected to this project.");
            progress.Close();

            Clipboard.Clear();
            SetupDialogs.ShowCompletion(root, isDemo);
        }
        catch (Exception ex)
        {
            SetupDialogs.ShowError(
                "SETUP STOPPED SAFELY",
                ex.Message + "\n\nNo hidden retry or recovery action was attempted.");
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

            if (!SetupDialogs.AskChooseAnotherProject())
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

        return SetupDialogs.ConfirmKeyReplacement();
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
import { readFileSync } from "node:fs";
import { Once } from "@once-agent/sdk";

if (!process.env.ONCE_API_KEY) {
  try {
    const envText = readFileSync(new URL("./.env", import.meta.url), "utf8");
    const keyLine = envText.split(/\r?\n/).find((line) => line.startsWith("ONCE_API_KEY="));
    if (keyLine) {
      process.env.ONCE_API_KEY = keyLine.slice("ONCE_API_KEY=".length).trim();
    }
  } catch {
    // The installer supplies ONCE_API_KEY directly during setup.
  }
}

if (!process.env.ONCE_API_KEY) {
  throw new Error("missing_once_api_key");
}

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
