namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        OnceTheme.Apply(this, "Connect to Once", new Size(1360, 860));
        AutoScroll = false;

        var body = new Panel
        {
            AutoScroll = true,
            Padding = new Padding(OnceTheme.S(48), OnceTheme.S(30), OnceTheme.S(48), OnceTheme.S(38)),
            BackColor = OnceTheme.Background,
        };

        var main = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 1,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = OnceTheme.Background,
        };
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 64F));
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, OnceTheme.S(34)));
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36F));
        main.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var left = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Margin = Padding.Empty,
            Padding = new Padding(OnceTheme.S(10), OnceTheme.S(4), OnceTheme.S(10), OnceTheme.S(20)),
            BackColor = OnceTheme.Background,
        };

        var kicker = new Label
        {
            Text = "ONCE / EXECUTION CORE",
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, OnceTheme.S(14)),
        };
        left.Controls.Add(kicker);
        left.Controls.Add(OnceTheme.Heading("CONNECT TO ONCE", 23F));

        var intro = OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_.");
        left.Controls.Add(intro);

        var card = new TableLayoutPanel
        {
            ColumnCount = 2,
            RowCount = 4,
            Width = OnceTheme.MaxContentWidth,
            Height = OnceTheme.S(248),
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(22)),
            Margin = new Padding(0, 0, 0, OnceTheme.S(18)),
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        card.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(38)));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(70)));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(46)));
        card.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var keyLabel = new Label
        {
            Text = "ONCE API KEY",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Anchor = AnchorStyles.Left,
            Margin = Padding.Empty,
        };
        card.Controls.Add(keyLabel, 0, 0);
        card.SetColumnSpan(keyLabel, 2);

        _apiKey = new TextBox
        {
            Dock = DockStyle.Fill,
            PlaceholderText = "once_test_...",
            Font = OnceTheme.Mono(10.5F),
            BackColor = Color.FromArgb(4, 13, 18),
            ForeColor = OnceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            UseSystemPasswordChar = true,
            Margin = new Padding(0, OnceTheme.S(6), OnceTheme.S(16), OnceTheme.S(8)),
        };

        var paste = OnceTheme.SecondaryButton("Paste", 145);
        paste.Dock = DockStyle.Fill;
        paste.Margin = new Padding(0, OnceTheme.S(6), 0, OnceTheme.S(8));
        paste.Click += (_, _) =>
        {
            try
            {
                var clipboardText = System.Windows.Forms.Clipboard.GetText()?.Trim() ?? string.Empty;
                if (clipboardText.Length > 0)
                {
                    _apiKey.Text = clipboardText;
                    _apiKey.SelectionStart = _apiKey.TextLength;
                }
            }
            catch
            {
                // Manual paste remains available.
            }
            _apiKey.Focus();
        };

        card.Controls.Add(_apiKey, 0, 1);
        card.Controls.Add(paste, 1, 1);

        var showKey = new CheckBox
        {
            Text = "Show key",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            BackColor = OnceTheme.Surface,
            Font = OnceTheme.Body(9.5F),
            Anchor = AnchorStyles.Left,
            Margin = Padding.Empty,
        };
        showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !showKey.Checked;
        card.Controls.Add(showKey, 0, 2);
        card.SetColumnSpan(showKey, 2);

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9F),
            Anchor = AnchorStyles.Left | AnchorStyles.Top,
            Margin = new Padding(0, OnceTheme.S(6), 0, 0),
        };
        card.Controls.Add(safeHint, 0, 3);
        card.SetColumnSpan(safeHint, 2);
        left.Controls.Add(card);

        var help = new LinkLabel
        {
            Text = "Need a key? Return to the Once evaluation page and click Copy API key.",
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.MaxContentWidth, 0),
            LinkColor = OnceTheme.Accent,
            ActiveLinkColor = Color.FromArgb(90, 255, 190),
            VisitedLinkColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, OnceTheme.S(4), 0, OnceTheme.S(26)),
        };
        left.Controls.Add(help);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, OnceTheme.S(10), 0, 0),
        };
        var cancel = OnceTheme.SecondaryButton("Cancel", 150);
        cancel.DialogResult = DialogResult.Cancel;
        var connect = OnceTheme.PrimaryButton("Continue  →", 190);
        connect.DialogResult = DialogResult.OK;
        cancel.Margin = new Padding(0, 0, OnceTheme.S(12), 0);
        connect.Margin = Padding.Empty;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        left.Controls.Add(buttons);

        var status = BuildStatusPanel();
        status.Dock = DockStyle.Top;
        status.Margin = new Padding(0, OnceTheme.S(12), 0, 0);

        main.Controls.Add(left, 0, 0);
        main.Controls.Add(status, 2, 0);
        body.Controls.Add(main);

        void LayoutContent()
        {
            var narrow = body.ClientSize.Width < OnceTheme.S(900);
            status.Visible = !narrow;
            main.ColumnStyles[0].SizeType = SizeType.Percent;
            main.ColumnStyles[0].Width = narrow ? 100F : 64F;
            main.ColumnStyles[1].SizeType = SizeType.Absolute;
            main.ColumnStyles[1].Width = narrow ? 0F : OnceTheme.S(34);
            main.ColumnStyles[2].SizeType = SizeType.Percent;
            main.ColumnStyles[2].Width = narrow ? 0F : 36F;

            var width = Math.Max(OnceTheme.S(420), left.ClientSize.Width - left.Padding.Horizontal - OnceTheme.S(12));
            card.Width = Math.Min(OnceTheme.MaxContentWidth, width);
            intro.MaximumSize = new Size(card.Width, 0);
            help.MaximumSize = new Size(card.Width, 0);
            safeHint.MaximumSize = new Size(Math.Max(OnceTheme.S(260), card.Width - OnceTheme.S(44)), 0);
            left.PerformLayout();
        }

        body.SizeChanged += (_, _) => LayoutContent();
        left.SizeChanged += (_, _) => LayoutContent();

        Controls.Add(OnceTheme.CreateChrome(body, 1));

        AcceptButton = connect;
        CancelButton = cancel;
        Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(this);
            LayoutContent();
            _apiKey.Focus();
        };
    }

    private static Panel BuildStatusPanel()
    {
        var panel = new Panel
        {
            Height = OnceTheme.S(390),
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(28)),
        };

        var flow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = false,
            BackColor = OnceTheme.Surface,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };

        var kicker = new Label
        {
            Text = "ONCE / SETUP STATUS",
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(8.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, OnceTheme.S(16)),
        };
        flow.Controls.Add(kicker);

        var title = new Label
        {
            Text = "READY TO CONNECT",
            AutoSize = true,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Display(16F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(18)),
        };
        flow.Controls.Add(title);

        var copy = new Label
        {
            Text = "Connect this machine, choose a project, then Once will verify the retry-safety path before setup completes.",
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.S(310), 0),
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(24)),
        };
        flow.Controls.Add(copy);

        foreach (var text in new[]
        {
            "●  Evaluation key handled locally",
            "●  Project source remains unchanged",
            "●  Retry protection verified during setup",
        })
        {
            flow.Controls.Add(new Label
            {
                Text = text,
                AutoSize = true,
                MaximumSize = new Size(OnceTheme.S(320), 0),
                ForeColor = text.StartsWith("●", StringComparison.Ordinal) ? OnceTheme.Text : OnceTheme.Muted,
                Font = OnceTheme.Body(9F),
                Margin = new Padding(0, 0, 0, OnceTheme.S(14)),
            });
        }

        panel.Controls.Add(flow);
        return panel;
    }
}
