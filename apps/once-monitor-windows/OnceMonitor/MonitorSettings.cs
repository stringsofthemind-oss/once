using Microsoft.Win32;
using System.Text.Json;
using Windows.ApplicationModel;

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

internal sealed record StartupPreferenceResult(
    bool Applied,
    bool Enabled,
    string? Error = null);

internal static class MonitorSettingsStore
{
    private const string StartupTaskId = "OnceMonitorStartup";
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

    internal static async Task<StartupPreferenceResult> ApplyStartWithWindowsAsync(bool enabled)
    {
        if (HasPackageIdentity())
        {
            try
            {
                var task = await StartupTask.GetAsync(StartupTaskId);

                if (!enabled)
                {
                    if (task.State == StartupTaskState.Enabled)
                    {
                        task.Disable();
                    }

                    return new StartupPreferenceResult(
                        Applied: true,
                        Enabled: false);
                }

                switch (task.State)
                {
                    case StartupTaskState.Enabled:
                        return new StartupPreferenceResult(true, true);

                    case StartupTaskState.Disabled:
                    {
                        var state = await task.RequestEnableAsync();
                        return state == StartupTaskState.Enabled
                            ? new StartupPreferenceResult(true, true)
                            : StartupStateFailure(state);
                    }

                    case StartupTaskState.DisabledByUser:
                        return new StartupPreferenceResult(
                            false,
                            false,
                            "Windows has disabled Once Monitor in Startup apps. Re-enable it from Windows Settings > Apps > Startup.");

                    case StartupTaskState.DisabledByPolicy:
                        return new StartupPreferenceResult(
                            false,
                            false,
                            "Windows policy does not allow Once Monitor to start automatically.");

                    default:
                        return StartupStateFailure(task.State);
                }
            }
            catch (Exception ex)
            {
                return new StartupPreferenceResult(
                    false,
                    false,
                    "Windows startup-task registration is unavailable: " + ex.Message);
            }
        }

        return ApplyRegistryStartup(enabled);
    }

    internal static async Task<bool> IsStartWithWindowsEnabledAsync()
    {
        if (HasPackageIdentity())
        {
            try
            {
                var task = await StartupTask.GetAsync(StartupTaskId);
                return task.State == StartupTaskState.Enabled;
            }
            catch
            {
                return false;
            }
        }

        return IsRegistryStartupEnabled();
    }

    private static bool HasPackageIdentity()
    {
        try
        {
            _ = Package.Current.Id.Name;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static StartupPreferenceResult ApplyRegistryStartup(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(StartupRegistryPath, writable: true);
            if (key is null)
            {
                return new StartupPreferenceResult(
                    false,
                    false,
                    "Windows startup settings are unavailable.");
            }

            if (enabled)
            {
                var executable = Environment.ProcessPath;
                if (string.IsNullOrWhiteSpace(executable))
                {
                    return new StartupPreferenceResult(
                        false,
                        false,
                        "Once Monitor could not locate its executable.");
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

            return new StartupPreferenceResult(true, enabled);
        }
        catch (Exception ex)
        {
            return new StartupPreferenceResult(false, false, ex.Message);
        }
    }

    private static bool IsRegistryStartupEnabled()
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

    private static StartupPreferenceResult StartupStateFailure(StartupTaskState state)
    {
        return new StartupPreferenceResult(
            false,
            state == StartupTaskState.Enabled,
            $"Windows returned startup state {state}.");
    }
}
