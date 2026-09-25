namespace OnceMonitor;

internal sealed class MonitorPanelForm : Form
{
    private readonly MonitorSettings _settings;
    private readonly Func<Task> _refreshAsync;
    private readonly Func<Task<string>> _runDoctorAsync;
    private readonly Action<MonitorSettings> _saveSettings;
    private readonly Action _copyDiagnostics;

    private readonly Panel _content = new();
    private readonly Label _statusPill = new();
    private readonly HeartbeatControl _heartbeat = new();
    private readonly Dictionary<string, Button> _navButtons = new(StringComparer.OrdinalIgnoreCase);

    private MonitorLoadResult _state = new(null, "Waiting for local Once status.");
    private string _activeView = "Overview";
    private bool _suspendAutoHide;

    internal MonitorPanelForm(
        MonitorSettings settings,
        Func<Task> refreshAsync,
        Func<Task<string>> runDoctorAsync,
        Action<MonitorSettings> saveSettings,
        Action copyDiagnostics)
    {
        _settings = settings;
        _refreshAsync = refreshAsync;
        _runDoctorAsync = runDoctorAsync;
        _saveSettings = saveSettings;
        _copyDiagnostics = copyDiagnostics;

        Text = "Once Monitor";
        BackColor = MonitorTheme.Background;
        ForeColor = MonitorTheme.Text;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(430, 650);
        Padding = new Padding(14);
        Font = MonitorTheme.Body;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = MonitorTheme.Background,
            ColumnCount = 1,
            RowCount = 4,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(_heartbeat, 0, 1);

        _content.Dock = DockStyle.Fill;
        _content.BackColor = MonitorTheme.Background;
        _content.AutoScroll = true;
        root.Controls.Add(_content, 0, 2);
        root.Controls.Add(BuildNavigation(), 0, 3);

        Controls.Add(root);

        Deactivate += (_, _) =>
        {
            if (!_suspendAutoHide)
            {
                Hide();
            }
        };

        RenderActiveView();
    }

    internal void ApplyState(MonitorLoadResult state)
    {
        _state = state;

        var (text, color) = StatePresentation(state);
        _statusPill.Text = text;
        _statusPill.ForeColor = color;
        _statusPill.BackColor = MonitorTheme.SurfaceRaised;

        RenderActiveView();
    }

    internal void PulseActivity() => _heartbeat.Pulse();

    internal void ShowView(string view)
    {
        _activeView = view;
        RenderActiveView();
        PositionNearTray();
        Show();
        Activate();
    }

    internal void ToggleOverview()
    {
        if (Visible)
        {
            Hide();
            return;
        }

        ShowView("Overview");
    }

    internal void PositionNearTray()
    {
        var screen = Screen.FromPoint(Cursor.Position);
        var working = screen.WorkingArea;
        Location = new Point(
            Math.Max(working.Left + 8, working.Right - Width - 10),
            Math.Max(working.Top + 8, working.Bottom - Height - 10));
    }

    private Control BuildHeader()
    {
        var header = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = MonitorTheme.Background,
        };

        var mark = new Label
        {
            Text = "1x",
            ForeColor = MonitorTheme.Accent,
            BackColor = MonitorTheme.AccentDeep,
            Font = new Font("Segoe UI Semibold", 12f, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleCenter,
            Location = new Point(0, 4),
            Size = new Size(42, 42),
        };

        var title = new Label
        {
            Text = "ONCE",
            ForeColor = MonitorTheme.Text,
            Font = MonitorTheme.Heading,
            AutoSize = true,
            Location = new Point(54, 4),
        };

        var tagline = new Label
        {
            Text = "THE SAME ACTION SHOULD HAPPEN ONCE.",
            ForeColor = MonitorTheme.Muted,
            Font = MonitorTheme.Small,
            AutoSize = true,
            Location = new Point(55, 34),
        };

        _statusPill.Text = "STARTING";
        _statusPill.ForeColor = MonitorTheme.Muted;
        _statusPill.BackColor = MonitorTheme.SurfaceRaised;
        _statusPill.Font = MonitorTheme.Small;
        _statusPill.TextAlign = ContentAlignment.MiddleCenter;
        _statusPill.AutoSize = false;
        _statusPill.Size = new Size(94, 28);
        _statusPill.Location = new Point(ClientSize.Width - 124, 8);
        _statusPill.Anchor = AnchorStyles.Top | AnchorStyles.Right;

        header.Controls.Add(mark);
        header.Controls.Add(title);
        header.Controls.Add(tagline);
        header.Controls.Add(_statusPill);
        return header;
    }

    private Control BuildNavigation()
    {
        var nav = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            BackColor = MonitorTheme.Background,
            Padding = new Padding(0, 5, 0, 0),
        };

        foreach (var name in new[] { "Overview", "Tools", "Activity", "Doctor", "Settings" })
        {
            var captured = name;
            var button = MonitorTheme.Button(name, (_, _) => ShowView(captured));
            button.Height = 34;
            button.Width = name == "Overview" ? 78 : 70;
            button.Padding = Padding.Empty;
            button.Margin = new Padding(0, 0, 5, 0);
            _navButtons[name] = button;
            nav.Controls.Add(button);
        }

        return nav;
    }

    private void RenderActiveView()
    {
        foreach (var pair in _navButtons)
        {
            pair.Value.ForeColor = pair.Key.Equals(_activeView, StringComparison.OrdinalIgnoreCase)
                ? MonitorTheme.Accent
                : MonitorTheme.Text;
        }

        _content.SuspendLayout();
        _content.Controls.Clear();

        Control view = _activeView switch
        {
            "Tools" => BuildToolsView(),
            "Activity" => BuildActivityView(),
            "Doctor" => BuildDoctorView(),
            "Settings" => BuildSettingsView(),
            _ => BuildOverviewView(),
        };

        view.Dock = DockStyle.Fill;
        _content.Controls.Add(view);
        _content.ResumeLayout();
    }

    private Control BuildOverviewView()
    {
        var flow = NewVerticalFlow();

        if (_state.Snapshot is not { } snapshot)
        {
            flow.Controls.Add(Card(
                "MONITOR STATUS",
                _state.Error ?? "Local status is unavailable.",
                MonitorTheme.Warning));

            if (string.IsNullOrWhiteSpace(_settings.ProjectDirectory))
            {
                var openSettings = MonitorTheme.Button("Choose project", (_, _) => ShowView("Settings"));
                flow.Controls.Add(openSettings);
            }

            return flow;
        }

        var protectionText = snapshot.Summary.Protected > 0
            ? $"{snapshot.Summary.Protected} tool(s) report a verified protection state."
            : "No verified protection state is present in this local snapshot yet.";

        flow.Controls.Add(Card(
            "PROTECTION",
            protectionText + Environment.NewLine +
            $"Needs attention  {snapshot.Summary.NeedsAttention}" + Environment.NewLine +
            $"Read-only / generation  {snapshot.Summary.ReadOnly}",
            snapshot.Summary.NeedsAttention > 0 ? MonitorTheme.Warning : MonitorTheme.Accent));

        var frameworks = snapshot.Tools
            .Select(tool => tool.Framework)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var environment =
            $"Project  {snapshot.Project.Name}{Environment.NewLine}" +
            $"Tools discovered  {snapshot.Summary.ToolsDiscovered}{Environment.NewLine}" +
            $"Model-visible  {snapshot.Summary.ModelVisible}{Environment.NewLine}" +
            $"Configured sources  {snapshot.Summary.ConfiguredSources}";

        if (frameworks.Length > 0)
        {
            environment += Environment.NewLine + "Framework  " + string.Join(", ", frameworks);
        }

        flow.Controls.Add(Card("ENVIRONMENT", environment, MonitorTheme.Text));

        flow.Controls.Add(Card(
            "EVIDENCE",
            $"Execution evidence  {snapshot.Summary.ExecutionEvidence}{Environment.NewLine}" +
            $"Unknown / review  {snapshot.Summary.Unknown}{Environment.NewLine}" +
            $"Updated  {snapshot.GeneratedAt.ToLocalTime():HH:mm:ss}",
            MonitorTheme.Activity));

        var refresh = MonitorTheme.Button("Refresh now", async (_, _) => await _refreshAsync());
        flow.Controls.Add(refresh);
        return flow;
    }

    private Control BuildToolsView()
    {
        var flow = NewVerticalFlow();

        if (_state.Snapshot is not { } snapshot)
        {
            flow.Controls.Add(Card("TOOLS", _state.Error ?? "Tool data is unavailable.", MonitorTheme.Warning));
            return flow;
        }

        flow.Controls.Add(MonitorTheme.Label(
            $"{snapshot.Summary.ToolsDiscovered} discovered tool record(s). Once shows safe metadata only.",
            muted: true));

        foreach (var tool in snapshot.Tools.Take(40))
        {
            var detail =
                $"{Pretty(tool.EffectClass)} · {tool.ImportanceBand}{Environment.NewLine}" +
                $"Action  {Pretty(tool.Action)}{Environment.NewLine}" +
                $"Evidence  {Pretty(tool.EvidenceLevel)}{Environment.NewLine}" +
                $"Protection  {Pretty(tool.Protection)}";

            var color = tool.Action is "CRITICAL_GAP" or "PROTECT_PRIORITY"
                ? MonitorTheme.Warning
                : tool.EffectClass is "READ_ONLY" or "GENERATION_ONLY"
                    ? MonitorTheme.Muted
                    : MonitorTheme.Accent;

            flow.Controls.Add(Card(tool.Name, detail, color));
        }

        if (snapshot.Tools.Count > 40)
        {
            flow.Controls.Add(MonitorTheme.Label(
                $"{snapshot.Tools.Count - 40} additional tool records are available through Once Doctor.",
                muted: true));
        }

        return flow;
    }

    private Control BuildActivityView()
    {
        var flow = NewVerticalFlow();

        if (_state.Snapshot is not { } snapshot)
        {
            flow.Controls.Add(Card("ACTIVITY", _state.Error ?? "Activity evidence is unavailable.", MonitorTheme.Warning));
            return flow;
        }

        flow.Controls.Add(Card(
            "EXECUTION EVIDENCE",
            $"{snapshot.Summary.ExecutionEvidence} tool record(s) currently carry executed evidence.",
            MonitorTheme.Activity));

        if (!snapshot.Capabilities.ChronologicalActivityFeed)
        {
            flow.Controls.Add(Card(
                "TIMELINE",
                "A chronological local activity feed is not available in this build. Once will not invent timestamps, retry suppressions, or event history that it has not actually observed.",
                MonitorTheme.Muted));
        }

        return flow;
    }

    private Control BuildDoctorView()
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = MonitorTheme.Background,
        };

        var doctor = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = false,
            BackColor = MonitorTheme.Surface,
            ForeColor = MonitorTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = MonitorTheme.Mono,
            Location = new Point(0, 44),
            Size = new Size(392, 430),
            Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            Text = "Doctor is local and read-only. Run it when you want a detailed project and tool-safety check.",
        };

        var run = MonitorTheme.Button("Run Doctor", (_, _) => { });
        run.Location = new Point(0, 0);
        run.Click += async (_, _) =>
        {
            run.Enabled = false;
            doctor.Text = "Running local read-only Once Doctor...";
            try
            {
                doctor.Text = await _runDoctorAsync();
            }
            finally
            {
                run.Enabled = true;
            }
        };

        var copy = MonitorTheme.Button("Copy diagnostics", (_, _) => _copyDiagnostics());
        copy.Location = new Point(112, 0);

        panel.Controls.Add(run);
        panel.Controls.Add(copy);
        panel.Controls.Add(doctor);
        return panel;
    }

    private Control BuildSettingsView()
    {
        var panel = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = MonitorTheme.Background,
        };

        var projectLabel = MonitorTheme.Label("PROJECT", heading: true);
        projectLabel.Location = new Point(0, 4);

        var project = new TextBox
        {
            Text = _settings.ProjectDirectory,
            BackColor = MonitorTheme.Surface,
            ForeColor = MonitorTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = MonitorTheme.Body,
            Location = new Point(0, 30),
            Width = 295,
        };

        var browse = MonitorTheme.Button("Browse", (_, _) =>
        {
            _suspendAutoHide = true;
            try
            {
                using var dialog = new FolderBrowserDialog
                {
                    Description = "Choose the project Once Monitor should inspect",
                    ShowNewFolderButton = false,
                    UseDescriptionForTitle = true,
                    SelectedPath = Directory.Exists(project.Text) ? project.Text : string.Empty,
                };

                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    project.Text = dialog.SelectedPath;
                }
            }
            finally
            {
                _suspendAutoHide = false;
                Activate();
            }
        });
        browse.Location = new Point(304, 26);
        browse.Width = 86;

        var start = CheckBox("Start Once Monitor with Windows", _settings.StartWithWindows, 78);
        var notifications = CheckBox("Enable meaningful Windows notifications", _settings.NotificationsEnabled, 112);
        var attention = CheckBox("Notify when tool safety needs attention", _settings.AttentionNotifications, 146);
        var activity = CheckBox("Notify on observed protection activity", _settings.ActivityNotifications, 180);
        var discovery = CheckBox("Refresh local discovery automatically", _settings.AutomaticDiscovery, 214);

        var refreshLabel = MonitorTheme.Label("Refresh interval", muted: true);
        refreshLabel.Location = new Point(0, 256);

        var refresh = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            BackColor = MonitorTheme.Surface,
            ForeColor = MonitorTheme.Text,
            Font = MonitorTheme.Body,
            Location = new Point(0, 280),
            Width = 160,
        };
        refresh.Items.AddRange(new object[] { "15 seconds", "30 seconds", "60 seconds", "120 seconds" });
        var index = _settings.RefreshSeconds switch
        {
            <= 15 => 0,
            <= 30 => 1,
            <= 60 => 2,
            _ => 3,
        };
        refresh.SelectedIndex = index;

        var save = MonitorTheme.Button("Save settings", async (_, _) =>
        {
            _settings.ProjectDirectory = project.Text.Trim();
            _settings.StartWithWindows = start.Checked;
            _settings.NotificationsEnabled = notifications.Checked;
            _settings.AttentionNotifications = attention.Checked;
            _settings.ActivityNotifications = activity.Checked;
            _settings.AutomaticDiscovery = discovery.Checked;
            _settings.RefreshSeconds = refresh.SelectedIndex switch
            {
                0 => 15,
                1 => 30,
                2 => 60,
                _ => 120,
            };

            _saveSettings(_settings);
            await _refreshAsync();
            ShowView("Overview");
        });
        save.Location = new Point(0, 326);

        var privacy = MonitorTheme.Label(
            "Monitor reads a secret-minimal local snapshot. It does not need prompts, tool arguments/results, API keys, credentials, or provider payloads.",
            muted: true);
        privacy.Location = new Point(0, 382);
        privacy.MaximumSize = new Size(390, 0);

        panel.Controls.Add(projectLabel);
        panel.Controls.Add(project);
        panel.Controls.Add(browse);
        panel.Controls.Add(start);
        panel.Controls.Add(notifications);
        panel.Controls.Add(attention);
        panel.Controls.Add(activity);
        panel.Controls.Add(discovery);
        panel.Controls.Add(refreshLabel);
        panel.Controls.Add(refresh);
        panel.Controls.Add(save);
        panel.Controls.Add(privacy);
        return panel;
    }

    private static CheckBox CheckBox(string text, bool value, int y)
    {
        return new CheckBox
        {
            Text = text,
            Checked = value,
            ForeColor = MonitorTheme.Text,
            BackColor = MonitorTheme.Background,
            Font = MonitorTheme.Body,
            AutoSize = true,
            Location = new Point(0, y),
        };
    }

    private static FlowLayoutPanel NewVerticalFlow()
    {
        return new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = MonitorTheme.Background,
            Padding = Padding.Empty,
        };
    }

    private static Panel Card(string title, string body, Color accent)
    {
        var card = MonitorTheme.Card();
        card.Width = 392;
        card.AutoSize = true;
        card.AutoSizeMode = AutoSizeMode.GrowAndShrink;

        var stack = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = MonitorTheme.Surface,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            Width = 366,
        };

        var heading = MonitorTheme.Label(title, heading: true);
        heading.ForeColor = accent;
        heading.Margin = new Padding(0, 0, 0, 6);

        var detail = MonitorTheme.Label(body);
        detail.MaximumSize = new Size(360, 0);
        detail.Margin = Padding.Empty;

        stack.Controls.Add(heading);
        stack.Controls.Add(detail);
        card.Controls.Add(stack);
        return card;
    }

    private static string Pretty(string value)
    {
        return value.Replace('_', ' ').ToLowerInvariant();
    }

    private static (string Text, Color Color) StatePresentation(MonitorLoadResult state)
    {
        if (state.Snapshot is null)
        {
            return ("UNAVAILABLE", MonitorTheme.Danger);
        }

        return state.Snapshot.Health switch
        {
            "ATTENTION" => ("ATTENTION", MonitorTheme.Warning),
            "NO_TOOLS_OBSERVED" => ("MONITORING", MonitorTheme.Muted),
            _ => ("READY", MonitorTheme.Accent),
        };
    }
}
