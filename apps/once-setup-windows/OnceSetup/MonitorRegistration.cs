using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OnceSetup;

internal static class MonitorRegistration
{
    private static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Once",
        "Monitor");

    private static string SettingsPath => Path.Combine(
        SettingsDirectory,
        "settings.json");

    internal static bool TryRegisterAndStart(string projectDirectory)
    {
        if (string.IsNullOrWhiteSpace(projectDirectory)
            || !Directory.Exists(projectDirectory))
        {
            return false;
        }

        try
        {
            RegisterProject(projectDirectory);
        }
        catch
        {
            // Monitor is an assistive surface. A registration problem must not
            // turn a completed Once protection setup into a failed setup.
            return false;
        }

        try
        {
            var monitorExecutable = Path.Combine(
                AppContext.BaseDirectory,
                "OnceMonitor.exe");

            if (!File.Exists(monitorExecutable))
            {
                return true;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = monitorExecutable,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = AppContext.BaseDirectory,
            };

            // The project path has already been written to the shared local
            // Monitor settings file. Do not duplicate it in a process command
            // line where it would be unnecessarily visible to process viewers.
            startInfo.ArgumentList.Add("--background");

            Process.Start(startInfo);
        }
        catch
        {
            // Once protection is already installed and verified. Monitor launch
            // failure is deliberately non-fatal and can be retried later.
        }

        return true;
    }

    private static void RegisterProject(string projectDirectory)
    {
        Directory.CreateDirectory(SettingsDirectory);

        JsonObject settings;
        if (File.Exists(SettingsPath))
        {
            try
            {
                settings = JsonNode.Parse(File.ReadAllText(SettingsPath)) as JsonObject
                    ?? new JsonObject();
            }
            catch (JsonException)
            {
                settings = new JsonObject();
            }
        }
        else
        {
            settings = new JsonObject();
        }

        // Preserve every existing Monitor preference and change only the local
        // project path selected by the customer during successful Once Setup.
        settings["ProjectDirectory"] = Path.GetFullPath(projectDirectory);

        var temporaryPath = SettingsPath + ".tmp";
        File.WriteAllText(
            temporaryPath,
            settings.ToJsonString(new JsonSerializerOptions
            {
                WriteIndented = true,
            }));

        File.Move(
            temporaryPath,
            SettingsPath,
            overwrite: true);
    }
}
