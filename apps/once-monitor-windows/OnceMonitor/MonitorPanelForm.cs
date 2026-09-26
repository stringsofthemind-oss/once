namespace OnceMonitor;

internal sealed class MonitorPanelForm : Form
{
    private readonly MonitorSettings _settings;
    private readonly Func<Task> _refreshAsync;
    private readonly Func<Task<string>> _runDoctorAsync;
    private readonly Action<MonitorSettings> _saveSettings;
    private readonly Action _copyDiagnostics;

    private readonly Panel _content = new();
    private readonly WebsitePill _statusPill = new();
    private readonly Dictionary<string, WebsiteButton> _navButtons = new(StringComparer.OrdinalIgnoreCase);

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
        BackColor = MonitorTheme.Border;
        ForeColor = MonitorTheme.Text;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);

        // Phase 12B deliberately doubles the previous 500 x 620 logical
        // footprint by area (760 x 820 = ~2x), then clamps to the monitor work
        // area. This keeps the tray experience substantial without becoming a
        // full-screen app on smaller displays.
        ClientSize = new Size(760, 820);
        MinimumSize = new Size(560, 620);
        Padding = new Padding(1);
        Font = MonitorTheme.Body;

        var background = new WebsiteBackgroundPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24, 22, 24, 24),
            Margin = Padding.Empty,
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildNavigation(), 0, 1);

        _content.Dock = DockStyle.Fill;
        _content.BackColor = Color.Transparent;
        _content.AutoScroll = false;
        _content.Margin = new Padding(0, 18, 0, 0);
        root.Controls.Add(_content, 0, 2);

        background.Controls.Add(root);
        Controls.Add(background);

        Resize += (_, _) => MonitorTheme.ApplyRoundedRegion(this, 28);
        HandleCreated += (_, _) => MonitorTheme.ApplyRoundedRegion(this, 28);

        Deactivate += (_, _) =>
        {
            if (!_suspendAutoHide)
            {
                Hide();
            }
        };

        RenderActiveView();
    }

    // Preserve a native shadow around the borderless rounded flyout.
    protected override CreateParams CreateParams
    {
        get
        {
            const int CsDropShadow = 0x00020000;
            var parameters = base.CreateParams;
            parameters.ClassStyle |= CsDropShadow;
            return parameters;
        }
    }

    internal void ApplyState(MonitorLoadResult state)
    {
        _state = state;
        var (text, color) = StatePresentation(state);
        _statusPill.Label = text;
        _statusPill.AccentColor = color;
        RenderActiveView();
    }

    // Activity remains represented by the tray icon and optional Windows
    // notification. The user-facing Monitor panel intentionally has no
    // heartbeat or decorative pulse animation.
    internal void PulseActivity()
    {
    }

    internal void ShowView(string view)
    {
        _activeView = view;
        RenderActiveView();

        if (!Visible)
        {
            Show();
        }

        PositionNearTray();
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

        // Keep a consistent physical footprint on scaled TVs / high-DPI
        // monitors. On a 1920x1080-class desktop this settles at 760x820,
        // approximately twice the area of the Phase 12 flyout.
        var desiredWidth = Math.Min(760, Math.Max(560, (int)(working.Width * 0.48)));
        var desiredHeight = Math.Min(820, Math.Max(620, (int)(working.Height * 0.82)));
        desiredWidth = Math.Min(desiredWidth, Math.Max(360, working.Width - 24));
        desiredHeight = Math.Min(desiredHeight, Math.Max(480, working.Height - 24));

        Size = new Size(desiredWidth, desiredHeight);
        MonitorTheme.ApplyRoundedRegion(this, 28);

        Location = new Point(
            Math.Max(working.Left + 10, working.Right - Width - 12),
            Math.Max(working.Top + 10, working.Bottom - Height - 12));
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        if (Visible && IsHandleCreated)
        {
            BeginInvoke(new Action(PositionNearTray));
        }
    }

    private Control BuildHeader()
    {
        var header = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            ColumnCount = 3,
            RowCount = 1,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 68));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 132));
        header.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var mark = new WebsitePanel
        {
            Radius = 15,
            FillColor = MonitorTheme.AccentWash,
            BorderColor = Color.FromArgb(54, 99, 115),
            BorderWidth = 1f,
            Size = new Size(54, 54),
            Anchor = AnchorStyles.Top | AnchorStyles.Left,
            Margin = new Padding(0, 5, 12, 0),
            Padding = Padding.Empty,
        };
        mark.Controls.Add(new Label
        {
            Text = "1x",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = MonitorTheme.Accent,
            BackColor = Color.Transparent,
            Font = new Font("Consolas", 12f, FontStyle.Bold),
        });

        var identity = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        identity.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        identity.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        identity.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        identity.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var title = new Label
        {
            Text = "ONCE MONITOR",
            ForeColor = MonitorTheme.Text,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Brand,
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.BottomLeft,
            Margin = Padding.Empty,
        };

        var product = new Label
        {
            Text = "AI AGENT EXECUTION SAFETY",
            ForeColor = MonitorTheme.Accent,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Small,
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Margin = Padding.Empty,
        };

        var tagline = new Label
        {
            Text = "THE SAME ACTION SHOULD HAPPEN ONCE.",
            ForeColor = MonitorTheme.Muted,
            BackColor = Color.Transparent,
            Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.TopLeft,
            AutoEllipsis = true,
            Margin = Padding.Empty,
        };

        identity.Controls.Add(title, 0, 0);
        identity.Controls.Add(product, 0, 1);
        identity.Controls.Add(tagline, 0, 2);

        _statusPill.Label = "STARTING";
        _statusPill.AccentColor = MonitorTheme.Muted;
        _statusPill.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _statusPill.Margin = new Padding(10, 9, 0, 0);

        header.Controls.Add(mark, 0, 0);
        header.Controls.Add(identity, 1, 0);
        header.Controls.Add(_statusPill, 2, 0);
        return header;
    }

    private Control BuildNavigation()
    {
        var shell = new WebsitePanel
        {
            Dock = DockStyle.Fill,
            Radius = 15,
            FillColor = Color.FromArgb(7, 12, 19),
            BorderColor = MonitorTheme.Border,
            BorderWidth = 1f,
            Padding = new Padding(6),
            Margin = Padding.Empty,
        };

        var nav = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 5,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        nav.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        for (var index = 0; index < 5; index++)
        {
            nav.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20F));
        }

        var names = new[] { "Overview", "Tools", "Activity", "Doctor", "Settings" };
        for (var index = 0; index < names.Length; index++)
        {
            var name = names[index];
            var captured = name;
            var button = MonitorTheme.Button(name, (_, _) => ShowView(captured));
            button.AutoSize = false;
            button.Dock = DockStyle.Fill;
            button.Radius = 10;
            button.Padding = Padding.Empty;
            button.Margin = new Padding(index == 0 ? 0 : 3, 0, index == names.Length - 1 ? 0 : 3, 0);
            _navButtons[name] = button;
            nav.Controls.Add(button, index, 0);
        }

        shell.Controls.Add(nav);
        return shell;
    }

    private void RenderActiveView()
    {
        foreach (var pair in _navButtons)
        {
            pair.Value.Active = pair.Key.Equals(_activeView, StringComparison.OrdinalIgnoreCase);
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
        flow.Controls.Add(SectionHeader("Overview", "Local execution-safety status at a glance."));

        if (_state.Snapshot is not { } snapshot)
        {
            flow.Controls.Add(Card(
                "MONITOR STATUS",
                _state.Error ?? "Local status is unavailable.",
                MonitorTheme.Warning));

            if (string.IsNullOrWhiteSpace(_settings.ProjectDirectory))
            {
                var openSettings = MonitorTheme.Button(
                    "Choose project",
                    (_, _) => ShowView("Settings"),
                    primary: true);
                openSettings.Margin = new Padding(0, 4, 0, 0);
                flow.Controls.Add(openSettings);
            }

            return flow;
        }

        var protectionText = snapshot.Summary.Protected > 0
            ? $"{snapshot.Summary.Protected} tool(s) report a verified protection state."
            : "No verified protection state is present in this local snapshot yet.";

        flow.Controls.Add(Card(
            "PROTECTION",
            protectionText + Environment.NewLine + Environment.NewLine +
            $"Needs attention   {snapshot.Summary.NeedsAttention}" + Environment.NewLine +
            $"Read-only / generation   {snapshot.Summary.ReadOnly}",
            snapshot.Summary.NeedsAttention > 0 ? MonitorTheme.Warning : MonitorTheme.Accent));

        var frameworks = snapshot.Tools
            .Select(tool => tool.Framework)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var environment =
            $"Project   {snapshot.Project.Name}{Environment.NewLine}" +
            $"Tools discovered   {snapshot.Summary.ToolsDiscovered}{Environment.NewLine}" +
            $"Model-visible   {snapshot.Summary.ModelVisible}{Environment.NewLine}" +
            $"Configured sources   {snapshot.Summary.ConfiguredSources}";

        if (frameworks.Length > 0)
        {
            environment += Environment.NewLine + "Framework   " + string.Join(", ", frameworks);
        }

        var evidence =
            $"Execution evidence   {snapshot.Summary.ExecutionEvidence}{Environment.NewLine}" +
            $"Unknown / review   {snapshot.Summary.Unknown}{Environment.NewLine}" +
            $"Updated   {snapshot.GeneratedAt.ToLocalTime():HH:mm:ss}";

        flow.Controls.Add(TwoCardRow(
            Card("ENVIRONMENT", environment, MonitorTheme.Text),
            Card("EVIDENCE", evidence, MonitorTheme.Activity)));

        var refresh = MonitorTheme.Button("Refresh now", async (_, _) => await _refreshAsync());
        refresh.Margin = new Padding(0, 4, 0, 0);
        flow.Controls.Add(refresh);
        return flow;
    }

    private Control BuildToolsView()
    {
        var flow = NewVerticalFlow();
        flow.Controls.Add(SectionHeader("Tools", "Safe local metadata from the current Once Tool Graph."));

        if (_state.Snapshot is not { } snapshot)
        {
            flow.Controls.Add(Card("TOOLS", _state.Error ?? "Tool data is unavailable.", MonitorTheme.Warning));
            return flow;
        }

        foreach (var tool in snapshot.Tools.Take(40))
        {
            var detail =
                $"{Pretty(tool.EffectClass)} · {tool.ImportanceBand}{Environment.NewLine}" +
                $"Action   {Pretty(tool.Action)}{Environment.NewLine}" +
                $"Evidence   {Pretty(tool.EvidenceLevel)}{Environment.NewLine}" +
                $"Protection   {Pretty(tool.Protection)}";

            var color = tool.Action is "CRITICAL_GAP" or "PROTECT_PRIORITY"
                ? MonitorTheme.Warning
                : tool.EffectClass is "READ_ONLY" or "GENERATION_ONLY"
                    ? MonitorTheme.Muted
                    : MonitorTheme.Accent;

            flow.Controls.Add(Card(tool.Name, detail, color));
        }

        if (snapshot.Tools.Count == 0)
        {
            flow.Controls.Add(Card(
                "NO TOOLS OBSERVED",
                "Once has not discovered a tool record in the selected project yet.",
                MonitorTheme.Muted));
        }
        else if (snapshot.Tools.Count > 40)
        {
            var remaining = MonitorTheme.Label(
                $"{snapshot.Tools.Count - 40} additional tool records are available through Once Doctor.",
                muted: true);
            remaining.Tag = "stretch";
            remaining.Margin = new Padding(0, 2, 0, 0);
            flow.Controls.Add(remaining);
        }

        return flow;
    }

    private Control BuildActivityView()
    {
        var flow = NewVerticalFlow();
        flow.Controls.Add(SectionHeader("Activity", "Evidence Once has actually observed — never an invented timeline."));

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
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 70));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        root.Controls.Add(SectionHeader("Doctor", "Detailed local, read-only project and tool-safety diagnostics."), 0, 0);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            BackColor = Color.Transparent,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };

        var run = MonitorTheme.Button("Run Doctor", (_, _) => { }, primary: true);
        var copy = MonitorTheme.Button("Copy diagnostics", (_, _) => _copyDiagnostics());
        run.Margin = new Padding(0, 0, 8, 6);
        copy.Margin = new Padding(0, 0, 0, 6);
        actions.Controls.Add(run);
        actions.Controls.Add(copy);

        var consoleShell = new WebsitePanel
        {
            Dock = DockStyle.Fill,
            Radius = 17,
            FillColor = Color.FromArgb(6, 11, 17),
            BorderColor = MonitorTheme.Border,
            Padding = new Padding(16),
            Margin = Padding.Empty,
        };

        var doctor = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            BackColor = Color.FromArgb(6, 11, 17),
            ForeColor = MonitorTheme.Text,
            BorderStyle = BorderStyle.None,
            Font = MonitorTheme.Mono,
            Dock = DockStyle.Fill,
            Text = "Doctor is local and read-only. Run it when you want a detailed project and tool-safety check.",
        };
        consoleShell.Controls.Add(doctor);

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

        root.Controls.Add(actions, 0, 1);
        root.Controls.Add(consoleShell, 0, 2);
        return root;
    }

    private Control BuildSettingsView()
    {
        var flow = NewVerticalFlow();
        flow.Controls.Add(SectionHeader("Settings", "Local Monitor preferences. Protection itself is not controlled here."));

        var projectCard = MonitorTheme.Card();
        projectCard.Tag = "stretch";
        projectCard.AutoSize = true;
        projectCard.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        projectCard.Padding = new Padding(20);

        var projectStack = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = Color.Transparent,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        projectStack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        projectStack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        projectStack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        projectStack.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var projectLabel = Kicker("PROJECT");
        projectLabel.Margin = new Padding(0, 0, 0, 10);
        projectStack.Controls.Add(projectLabel, 0, 0);

        var projectRow = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        projectRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));

        var project = new TextBox
        {
            Text = _settings.ProjectDirectory,
            BackColor = MonitorTheme.SurfaceRaised,
            ForeColor = MonitorTheme.Text,
            BorderStyle = BorderStyle.None,
            Font = MonitorTheme.Body,
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
        };

        var field = new WebsitePanel
        {
            Radius = 12,
            FillColor = MonitorTheme.SurfaceRaised,
            BorderColor = MonitorTheme.Border,
            Height = 44,
            Dock = DockStyle.Fill,
            Padding = new Padding(12, 12, 12, 8),
            Margin = new Padding(0, 0, 10, 0),
        };
        field.Controls.Add(project);

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
        browse.AutoSize = false;
        browse.Dock = DockStyle.Fill;
        browse.Margin = Padding.Empty;

        projectRow.Controls.Add(field, 0, 0);
        projectRow.Controls.Add(browse, 1, 0);
        projectStack.Controls.Add(projectRow, 0, 1);

        var projectHint = MonitorTheme.Label("Monitor reads this project locally and does not upload source code.", muted: true);
        projectHint.Margin = new Padding(0, 10, 0, 0);
        projectStack.Controls.Add(projectHint, 0, 2);
        projectCard.Controls.Add(projectStack);
        flow.Controls.Add(projectCard);

        var preferenceCard = MonitorTheme.Card();
        preferenceCard.Tag = "stretch";
        preferenceCard.AutoSize = true;
        preferenceCard.AutoSizeMode = AutoSizeMode.GrowAndShrink;

        var prefs = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = Color.Transparent,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        var prefTitle = Kicker("MONITOR PREFERENCES");
        prefTitle.Margin = new Padding(0, 0, 0, 12);
        prefs.Controls.Add(prefTitle);

        var start = CheckBox("Start Once Monitor with Windows", _settings.StartWithWindows);
        var notifications = CheckBox("Enable meaningful Windows notifications", _settings.NotificationsEnabled);
        var attention = CheckBox("Notify when tool safety needs attention", _settings.AttentionNotifications);
        var activity = CheckBox("Notify on observed protection activity", _settings.ActivityNotifications);
        var discovery = CheckBox("Refresh local discovery automatically", _settings.AutomaticDiscovery);
        prefs.Controls.Add(start);
        prefs.Controls.Add(notifications);
        prefs.Controls.Add(attention);
        prefs.Controls.Add(activity);
        prefs.Controls.Add(discovery);

        var refreshLabel = MonitorTheme.Label("Refresh interval", muted: true);
        refreshLabel.Margin = new Padding(0, 10, 0, 5);
        prefs.Controls.Add(refreshLabel);

        var refresh = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            FlatStyle = FlatStyle.Flat,
            BackColor = MonitorTheme.SurfaceRaised,
            ForeColor = MonitorTheme.Text,
            Font = MonitorTheme.Body,
            Width = 190,
            Height = 36,
            Margin = new Padding(0, 0, 0, 14),
        };
        refresh.Items.AddRange(new object[] { "15 seconds", "30 seconds", "60 seconds", "120 seconds" });
        refresh.SelectedIndex = _settings.RefreshSeconds switch
        {
            <= 15 => 0,
            <= 30 => 1,
            <= 60 => 2,
            _ => 3,
        };
        prefs.Controls.Add(refresh);

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
        }, primary: true);
        save.Margin = Padding.Empty;
        prefs.Controls.Add(save);
        preferenceCard.Controls.Add(prefs);
        flow.Controls.Add(preferenceCard);

        flow.Controls.Add(Card(
            "PRIVACY",
            "Monitor reads a secret-minimal local snapshot. It does not need prompts, tool arguments/results, API keys, credentials, or provider payloads.",
            MonitorTheme.Muted));

        return flow;
    }

    private static CheckBox CheckBox(string text, bool value)
    {
        return new CheckBox
        {
            Text = text,
            Checked = value,
            ForeColor = MonitorTheme.Text,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Body,
            FlatStyle = FlatStyle.Flat,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 9),
            Padding = new Padding(1, 0, 0, 0),
        };
    }

    private static Control SectionHeader(string title, string subtitle)
    {
        var block = new TableLayoutPanel
        {
            Tag = "stretch",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 0, 0, 16),
            Padding = Padding.Empty,
        };
        block.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        block.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        block.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var heading = new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = MonitorTheme.Text,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Heading,
            Margin = new Padding(0, 0, 0, 4),
        };
        var detail = MonitorTheme.Label(subtitle, muted: true);
        detail.Margin = Padding.Empty;
        block.Controls.Add(heading, 0, 0);
        block.Controls.Add(detail, 0, 1);
        return block;
    }

    private static Label Kicker(string text)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            ForeColor = MonitorTheme.Accent,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Small,
        };
    }

    private static FlowLayoutPanel NewVerticalFlow()
    {
        var flow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            BackColor = Color.Transparent,
            Padding = new Padding(0, 0, 4, 0),
            Margin = Padding.Empty,
        };

        void ResizeChildren()
        {
            var scrollAllowance = flow.VerticalScroll.Visible
                ? SystemInformation.VerticalScrollBarWidth
                : 0;
            var available = Math.Max(
                300,
                flow.ClientSize.Width - flow.Padding.Horizontal - scrollAllowance - 6);

            foreach (Control child in flow.Controls)
            {
                if (!Equals(child.Tag, "stretch"))
                {
                    continue;
                }

                child.MinimumSize = new Size(available, 0);
                child.MaximumSize = new Size(available, 0);
                child.Width = available;
            }
        }

        flow.SizeChanged += (_, _) => ResizeChildren();
        flow.ControlAdded += (_, _) => BeginResize(flow, ResizeChildren);
        return flow;
    }

    private static void BeginResize(Control control, Action resize)
    {
        if (control.IsHandleCreated)
        {
            control.BeginInvoke(resize);
            return;
        }

        EventHandler? created = null;
        created = (_, _) =>
        {
            if (created is not null)
            {
                control.HandleCreated -= created;
            }
            control.BeginInvoke(resize);
        };
        control.HandleCreated += created;
    }

    private static Control TwoCardRow(Control left, Control right)
    {
        left.Tag = null;
        right.Tag = null;
        left.Dock = DockStyle.Fill;
        right.Dock = DockStyle.Fill;
        left.Margin = new Padding(0, 0, 7, 0);
        right.Margin = new Padding(7, 0, 0, 0);

        var row = new TableLayoutPanel
        {
            Tag = "stretch",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = Color.Transparent,
            Margin = new Padding(0, 0, 0, 14),
            Padding = Padding.Empty,
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        row.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        row.Controls.Add(left, 0, 0);
        row.Controls.Add(right, 1, 0);
        return row;
    }

    private static Control Card(string title, string body, Color accent)
    {
        var card = MonitorTheme.Card();
        card.Tag = "stretch";
        card.AutoSize = true;
        card.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        card.MinimumSize = new Size(0, 112);

        var stack = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = Color.Transparent,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var heading = new Label
        {
            Text = title,
            ForeColor = accent,
            BackColor = Color.Transparent,
            Font = MonitorTheme.Small,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 12),
        };

        var detail = MonitorTheme.Label(body);
        detail.Margin = Padding.Empty;

        card.SizeChanged += (_, _) =>
        {
            var textWidth = Math.Max(180, card.ClientSize.Width - card.Padding.Horizontal - 2);
            heading.MaximumSize = new Size(textWidth, 0);
            detail.MaximumSize = new Size(textWidth, 0);
            stack.MaximumSize = new Size(textWidth, 0);
        };

        stack.Controls.Add(heading, 0, 0);
        stack.Controls.Add(detail, 0, 1);
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