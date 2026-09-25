using System.Threading;

namespace OnceMonitor;

internal static class Program
{
    private const string SingleInstanceMutexName = @"Local\Once.Monitor.Windows.SingleInstance";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Any(value => value.Equals("--self-test", StringComparison.OrdinalIgnoreCase)))
        {
            return MonitorSelfTest.Run();
        }

        var projectArgument = ReadArgument(args, "--project");
        if (!string.IsNullOrWhiteSpace(projectArgument))
        {
            MonitorSettingsStore.RegisterProject(projectArgument);
        }

        if (args.Any(value => value.Equals("--register-only", StringComparison.OrdinalIgnoreCase)))
        {
            return 0;
        }

        using var singleInstance = new Mutex(
            initiallyOwned: true,
            name: SingleInstanceMutexName,
            createdNew: out var isFirstInstance);

        if (!isFirstInstance)
        {
            return 0;
        }

        ApplicationConfiguration.Initialize();
        var settings = MonitorSettingsStore.Load();
        using var context = new MonitorApplicationContext(settings);
        Application.Run(context);
        return 0;
    }

    private static string? ReadArgument(string[] args, string name)
    {
        for (var index = 0; index < args.Length; index++)
        {
            if (!args[index].Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return index + 1 < args.Length
                ? args[index + 1]
                : null;
        }

        return null;
    }
}
