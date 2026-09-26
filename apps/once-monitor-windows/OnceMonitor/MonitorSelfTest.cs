using System.Text.Json;

namespace OnceMonitor;

internal static class MonitorSelfTest
{
    internal static int Run()
    {
        try
        {
            const string sample = """
            {
              "schema":"once.monitor.snapshot.v1",
              "generatedAt":"2026-09-25T16:00:00Z",
              "project":{"name":"sample-project"},
              "environment":{"nodeVersion":"24.15.0","languages":["TypeScript"],"tooling":["npm"]},
              "health":"ATTENTION",
              "summary":{"configuredSources":1,"toolsDiscovered":2,"modelVisible":1,"executionEvidence":1,"readOnly":1,"protected":1,"needsAttention":1,"unknown":0},
              "tools":[
                {"toolId":"tool:1","name":"charge_card","evidenceLevel":"EXECUTED","effectClass":"MONEY_MOVEMENT","importanceBand":"I5","action":"CRITICAL_GAP","protection":"NONE","visibility":{"configured":false,"runtimeRegistered":true,"modelVisible":true,"executed":true}}
              ],
              "capabilities":{"chronologicalActivityFeed":false},
              "privacy":{"localReadOnly":true,"sourceUploaded":false,"secretValuesIncluded":false,"payloadsIncluded":false,"absolutePathsIncluded":false}
            }
            """;

            var snapshot = JsonSerializer.Deserialize<MonitorSnapshot>(sample);
            if (snapshot is null
                || snapshot.Schema != "once.monitor.snapshot.v1"
                || snapshot.Project.Name != "sample-project"
                || snapshot.Summary.NeedsAttention != 1
                || snapshot.Tools.Count != 1)
            {
                return 2;
            }

            using var ready = OnceIconFactory.Create(TrayVisualState.Ready);
            using var activity = OnceIconFactory.Create(TrayVisualState.Activity);
            using var attention = OnceIconFactory.Create(TrayVisualState.Attention);
            using var problem = OnceIconFactory.Create(TrayVisualState.Problem);

            var diagnostics = MonitorStatusService.BuildSanitizedDiagnostics(
                new MonitorLoadResult(snapshot, null));

            if (!diagnostics.Contains("sample-project", StringComparison.Ordinal)
                || diagnostics.Contains("API_KEY", StringComparison.OrdinalIgnoreCase)
                || diagnostics.Contains("tool arguments", StringComparison.OrdinalIgnoreCase))
            {
                return 3;
            }

            // Construct the real flyout shell so CI catches WinForms startup
            // regressions (for example unsupported transparent backgrounds)
            // before a private MSIX reaches a real Windows machine.
            using var panel = new MonitorPanelForm(
                new MonitorSettings(),
                () => Task.CompletedTask,
                () => Task.FromResult("Doctor self-test"),
                _ => { },
                () => { });

            if (panel.ClientSize.Width < 700 || panel.ClientSize.Height < 760)
            {
                return 4;
            }

            return 0;
        }
        catch
        {
            return 1;
        }
    }
}
