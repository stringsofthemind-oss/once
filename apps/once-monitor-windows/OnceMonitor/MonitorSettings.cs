using Microsoft.Win32;
using System.Text.Json;

namespace OnceMonitor;

internal sealed class MonitorSettings
{
    public string ProjectDirectory { get; set; } = string.Empty;
    public bool StartWithWindows { get; set; }
    public bool NotificationsEnabled { get; set; } = true;
    public bool AttentionNotifications { get; set; } = true;
    public bool ActivityNotifications { get; set; }
    public bool AutomaticDiscovery { get; set; } = true;
    public int RefreshSeconds { get; set; } = 30;
}

internal static class MonitorSettingsStore
{
    private const string StartupValueName = "Once Monitor";
    private const string StartupRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    internal static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Once",
        "Monitor");

    internal static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");

    internal static MonitorSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
            {
                return new MonitorSettings();
            }

            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<MonitorSettings>(json)
                ?? new MonitorSettings();
        }
        catch
        {
            // Corrupt or inaccessible preferences must not affect protection.
            return new MonitorSettings();
        }
    }

    internal static void Save(MonitorSettings settings)
    {
        Directory.CreateDirectory(SettingsDirectory);
        var json = JsonSerializer.Serialize(
            settings,
            new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(SettingsPath, json);
    }

    internal static void RegisterProject(string projectDirectory)
    {
        if (string.IsNullOrWhiteSpace(projectDirectory) || !Directory.Exists(projectDirectory))
        {
            return;
        }

        var settings = Load();
        settings.ProjectDirectory = Path.GetFullPath(projectDirectory);
        Save(settings);
    }

    internal static bool TrySetStartWithWindows(bool enabled, out string? error)
    {
        error = null;

        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(StartupRegistryPath, writable: true);
            if (key is null)
            {
                error = "Windows startup settings are unavailable.";
                return false;
            }

            if (enabled)
            {
                var executable = Environment.ProcessPath;
                if (string.IsNullOrWhiteSpace(executable))
                {
                    error = "Once Monitor could not locate its executable.";
                    return false;
                }

                key.SetValue(
                    StartupValueName,
                    $"\"{executable}\" --background",
                    RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(StartupValueName, throwOnMissingValue: false);
            }

            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    internal static bool IsStartWithWindowsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(StartupRegistryPath, writable: false);
            return key?.GetValue(StartupValueName) is string value
                && !string.IsNullOrWhiteSpace(value);
        }
        catch
        {
            return false;
        }
    }
}
