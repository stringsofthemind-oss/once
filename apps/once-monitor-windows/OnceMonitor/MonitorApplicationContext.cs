namespace OnceMonitor;

internal sealed class MonitorApplicationContext : ApplicationContext
{
    private readonly MonitorStatusService _statusService = new();
    private readonly MonitorSettings _settings;
    private readonly NotifyIcon _notifyIcon;
    private readonly MonitorPanelForm _panel;
    private readonly System.Windows.Forms.Timer _refreshTimer;

    private Icon? _currentIcon;
    private MonitorLoadResult _state = new(null, "Waiting for local Once status.");
    private bool _refreshing;
    private int? _previousExecutionEvidence;
    private int? _previousAttention;
    private readonly System.Windows.Forms.Timer _activityResetTimer;

    internal MonitorApplicationContext(MonitorSettings settings)
    {
        _settings = settings;

        _panel = new MonitorPanelForm(
            _settings,
            RefreshAsync,
            () => _statusService.RunDoctorAsync(_settings),
            settings => _ = SaveSettingsAsync(settings),
            CopyDiagnostics);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Once", null, (_, _) => _panel.ShowView("Overview"));
        menu.Items.Add("Doctor", null, async (_, _) =>
        {
            _panel.ShowView("Doctor");
            await RefreshAsync();
        });
        menu.Items.Add("Settings", null, (_, _) => _panel.ShowView("Settings"));
        menu.Items.Add("Copy diagnostics", null, (_, _) => CopyDiagnostics());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit Monitor", null, (_, _) => ExitMonitor());

        _currentIcon = OnceIconFactory.Create(TrayVisualState.Ready);
        _notifyIcon = new NotifyIcon
        {
            Icon = _currentIcon,
            Text = "Once Monitor · starting",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _notifyIcon.MouseClick += (_, eventArgs) =>
        {
            if (eventArgs.Button == MouseButtons.Left)
            {
                _panel.ToggleOverview();
            }
        };
        _notifyIcon.DoubleClick += (_, _) => _panel.ShowView("Overview");

        _refreshTimer = new System.Windows.Forms.Timer();
        _refreshTimer.Tick += async (_, _) => await RefreshAsync();
        ResetRefreshTimer();

        _activityResetTimer = new System.Windows.Forms.Timer { Interval = 1400 };
        _activityResetTimer.Tick += (_, _) =>
        {
            _activityResetTimer.Stop();
            UpdateTrayFromState();
        };

        _ = InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        _settings.StartWithWindows =
            await MonitorSettingsStore.IsStartWithWindowsEnabledAsync();

        if (!_settings.WelcomeShown && _settings.NotificationsEnabled)
        {
            ShowNotification(
                "Once Monitor is ready",
                "Look for the 1x icon in the Windows system tray. Click it to view local Once status, tools, Doctor, and settings.",
                ToolTipIcon.Info);
            _settings.WelcomeShown = true;
        }

        MonitorSettingsStore.Save(_settings);
        await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        if (_refreshing)
        {
            return;
        }

        _refreshing = true;
        try
        {
            var next = await _statusService.LoadSnapshotAsync(_settings);
            var nextExecution = next.Snapshot?.Summary.ExecutionEvidence;
            var nextAttention = next.Snapshot?.Summary.NeedsAttention;

            var activityIncreased =
                _previousExecutionEvidence.HasValue
                && nextExecution.HasValue
                && nextExecution.Value > _previousExecutionEvidence.Value;

            var attentionIncreased =
                _previousAttention.HasValue
                && nextAttention.HasValue
                && nextAttention.Value > _previousAttention.Value;

            _state = next;
            _panel.ApplyState(next);

            if (activityIncreased)
            {
                _panel.PulseActivity();
                SetTrayVisual(TrayVisualState.Activity, "Once Monitor · new execution evidence");
                _activityResetTimer.Stop();
                _activityResetTimer.Start();

                if (_settings.NotificationsEnabled && _settings.ActivityNotifications)
                {
                    ShowNotification(
                        "Once observed new execution evidence",
                        "The local Tool Graph changed. Open Once Monitor to review the current evidence.",
                        ToolTipIcon.Info);
                }
            }
            else
            {
                UpdateTrayFromState();
            }

            if (attentionIncreased
                && _settings.NotificationsEnabled
                && _settings.AttentionNotifications)
            {
                ShowNotification(
                    "Once needs attention",
                    $"{nextAttention} tool safety record(s) now need review.",
                    ToolTipIcon.Warning);
            }

            _previousExecutionEvidence = nextExecution;
            _previousAttention = nextAttention;
        }
        finally
        {
            _refreshing = false;
        }
    }

    private async Task SaveSettingsAsync(MonitorSettings settings)
    {
        var startup =
            await MonitorSettingsStore.ApplyStartWithWindowsAsync(
                settings.StartWithWindows);

        settings.StartWithWindows = startup.Enabled;

        if (!startup.Applied && !string.IsNullOrWhiteSpace(startup.Error))
        {
            ShowNotification(
                "Once Monitor startup setting not changed",
                startup.Error,
                ToolTipIcon.Warning,
                respectNotificationPreference: false);
        }

        MonitorSettingsStore.Save(settings);
        ResetRefreshTimer();
    }

    private void ResetRefreshTimer()
    {
        _refreshTimer.Stop();

        if (!_settings.AutomaticDiscovery)
        {
            return;
        }

        var seconds = Math.Clamp(_settings.RefreshSeconds, 15, 300);
        _refreshTimer.Interval = seconds * 1000;
        _refreshTimer.Start();
    }

    private void CopyDiagnostics()
    {
        try
        {
            Clipboard.SetText(MonitorStatusService.BuildSanitizedDiagnostics(_state));
            ShowNotification(
                "Once diagnostics copied",
                "Sanitized local diagnostics are ready to paste. Secrets and payloads are not included.",
                ToolTipIcon.Info);
        }
        catch
        {
            ShowNotification(
                "Once diagnostics unavailable",
                "Windows did not allow access to the clipboard.",
                ToolTipIcon.Warning,
                respectNotificationPreference: false);
        }
    }

    private void UpdateTrayFromState()
    {
        if (_state.Snapshot is null)
        {
            SetTrayVisual(TrayVisualState.Problem, "Once Monitor · local status unavailable");
            return;
        }

        if (_state.Snapshot.Health == "ATTENTION")
        {
            SetTrayVisual(TrayVisualState.Attention, "Once Monitor · attention needed");
            return;
        }

        SetTrayVisual(TrayVisualState.Ready, "Once Monitor · ready");
    }

    private void SetTrayVisual(TrayVisualState visualState, string tooltip)
    {
        var replacement = OnceIconFactory.Create(visualState);
        var previous = _currentIcon;
        _currentIcon = replacement;
        _notifyIcon.Icon = replacement;
        _notifyIcon.Text = tooltip.Length <= 63 ? tooltip : tooltip[..63];
        previous?.Dispose();
    }

    private void ShowNotification(
        string title,
        string text,
        ToolTipIcon icon,
        bool respectNotificationPreference = true)
    {
        if (respectNotificationPreference && !_settings.NotificationsEnabled)
        {
            return;
        }

        _notifyIcon.BalloonTipTitle = title;
        _notifyIcon.BalloonTipText = text;
        _notifyIcon.BalloonTipIcon = icon;
        _notifyIcon.ShowBalloonTip(4500);
    }

    private void ExitMonitor()
    {
        // This exits only the customer-facing Monitor UI. Once protection lives
        // in the SDK/Gateway/Connect execution path and is intentionally not
        // controlled by this process.
        _notifyIcon.Visible = false;
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        _refreshTimer.Stop();
        _activityResetTimer.Stop();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _currentIcon?.Dispose();
        _panel.Dispose();
        _refreshTimer.Dispose();
        _activityResetTimer.Dispose();
        base.ExitThreadCore();
    }
}
