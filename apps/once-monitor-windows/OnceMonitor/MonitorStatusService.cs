using System.Diagnostics;
using System.Text.Json;

namespace OnceMonitor;

internal sealed class MonitorStatusService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    internal async Task<MonitorLoadResult> LoadSnapshotAsync(
        MonitorSettings settings,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(settings.ProjectDirectory))
        {
            return new MonitorLoadResult(
                null,
                "Choose the project that Once should monitor.");
        }

        if (!Directory.Exists(settings.ProjectDirectory))
        {
            return new MonitorLoadResult(
                null,
                "The configured project folder is no longer available.");
        }

        var node = FindOnPath("node.exe");
        if (node is null)
        {
            return new MonitorLoadResult(
                null,
                "Node.js was not found. Once discovery needs Node.js 18 or newer.");
        }

        var monitorCli = Path.Combine(
            settings.ProjectDirectory,
            "node_modules",
            "@once-agent",
            "sdk",
            "dist",
            "monitor-cli.js");

        if (!File.Exists(monitorCli))
        {
            return new MonitorLoadResult(
                null,
                "This project does not yet expose the Once Monitor snapshot. Update the local Once SDK when a Monitor-enabled release is available.");
        }

        try
        {
            var result = await RunNodeAsync(
                node,
                monitorCli,
                new[] { "snapshot", settings.ProjectDirectory },
                settings.ProjectDirectory,
                TimeSpan.FromSeconds(12),
                cancellationToken);

            if (result.ExitCode != 0)
            {
                return new MonitorLoadResult(
                    null,
                    CleanError(result.StandardError, "Once Monitor snapshot could not be created."));
            }

            var snapshot = JsonSerializer.Deserialize<MonitorSnapshot>(
                result.StandardOutput,
                JsonOptions);

            if (snapshot is null || snapshot.Schema != "once.monitor.snapshot.v1")
            {
                return new MonitorLoadResult(
                    null,
                    "Once returned an unsupported Monitor snapshot format.");
            }

            if (!IsSafeSnapshot(snapshot))
            {
                return new MonitorLoadResult(
                    null,
                    "Once rejected a Monitor snapshot because its privacy contract was not satisfied.");
            }

            return new MonitorLoadResult(snapshot, null);
        }
        catch (OperationCanceledException)
        {
            return new MonitorLoadResult(
                null,
                "Once Monitor snapshot timed out safely.");
        }
        catch
        {
            return new MonitorLoadResult(
                null,
                "Once Monitor could not read local status. Protection was not changed.");
        }
    }

    internal async Task<string> RunDoctorAsync(
        MonitorSettings settings,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(settings.ProjectDirectory)
            || !Directory.Exists(settings.ProjectDirectory))
        {
            return "Choose an available Once project before running Doctor.";
        }

        var node = FindOnPath("node.exe");
        if (node is null)
        {
            return "Node.js was not found. Doctor needs Node.js 18 or newer.";
        }

        var doctorCli = Path.Combine(
            settings.ProjectDirectory,
            "node_modules",
            "@once-agent",
            "sdk",
            "dist",
            "cli.js");

        if (!File.Exists(doctorCli))
        {
            return "The Once SDK CLI is not installed in this project.";
        }

        try
        {
            var result = await RunNodeAsync(
                node,
                doctorCli,
                new[] { "doctor", settings.ProjectDirectory, "--tools" },
                settings.ProjectDirectory,
                TimeSpan.FromSeconds(25),
                cancellationToken);

            var output = string.Join(
                Environment.NewLine,
                new[] { result.StandardOutput, result.StandardError }
                    .Where(value => !string.IsNullOrWhiteSpace(value)))
                .Trim();

            return string.IsNullOrWhiteSpace(output)
                ? "Doctor completed without console output."
                : output;
        }
        catch (OperationCanceledException)
        {
            return "Doctor timed out safely. No protection setting was changed.";
        }
        catch
        {
            return "Doctor could not run. No protection setting was changed.";
        }
    }

    internal static string BuildSanitizedDiagnostics(
        MonitorLoadResult state)
    {
        var version = typeof(MonitorStatusService).Assembly.GetName().Version?.ToString(3) ?? "unknown";
        var lines = new List<string>
        {
            $"Once Monitor {version}",
            $"Windows: {Environment.OSVersion.VersionString}",
        };

        if (state.Snapshot is { } snapshot)
        {
            lines.Add($"Project: {snapshot.Project.Name}");
            lines.Add($"Health: {snapshot.Health}");
            lines.Add($"Tools discovered: {snapshot.Summary.ToolsDiscovered}");
            lines.Add($"Model-visible: {snapshot.Summary.ModelVisible}");
            lines.Add($"Execution evidence: {snapshot.Summary.ExecutionEvidence}");
            lines.Add($"Protected: {snapshot.Summary.Protected}");
            lines.Add($"Needs attention: {snapshot.Summary.NeedsAttention}");
            lines.Add($"Configured sources: {snapshot.Summary.ConfiguredSources}");
            lines.Add($"Node.js: {snapshot.Environment.NodeVersion}");
            lines.Add("Snapshot privacy: local/read-only; no payloads, secrets, or absolute paths");
        }
        else
        {
            lines.Add("Snapshot: unavailable");
            lines.Add($"Reason: {state.Error ?? "unknown"}");
        }

        return string.Join(Environment.NewLine, lines);
    }

    private static bool IsSafeSnapshot(MonitorSnapshot snapshot)
    {
        return snapshot.Privacy.LocalReadOnly
            && !snapshot.Privacy.SourceUploaded
            && !snapshot.Privacy.SecretValuesIncluded
            && !snapshot.Privacy.PayloadsIncluded
            && !snapshot.Privacy.AbsolutePathsIncluded;
    }

    private static string CleanError(string value, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        var firstLine = value
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();

        return string.IsNullOrWhiteSpace(firstLine)
            ? fallback
            : firstLine.Trim();
    }

    private static string? FindOnPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(
                     ';',
                     StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
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
                // Ignore malformed PATH entries.
            }
        }

        return null;
    }

    private static async Task<ProcessResult> RunNodeAsync(
        string node,
        string script,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        startInfo.ArgumentList.Add(script);
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            throw new InvalidOperationException("Could not start the local Once CLI.");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);

        using var timeoutSource = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(
            timeoutSource.Token,
            cancellationToken);

        try
        {
            await process.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Timeout cleanup must not become a second failure.
            }

            throw;
        }

        return new ProcessResult(
            process.ExitCode,
            await stdoutTask,
            await stderrTask);
    }

    private sealed record ProcessResult(
        int ExitCode,
        string StandardOutput,
        string StandardError);
}
