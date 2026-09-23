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
            Padding = new Padding(OnceTheme.S(44), OnceTheme.S(28), OnceTheme.S(44), OnceTheme.S(36)),
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
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, OnceTheme.S(34)));
        main.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
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
            UseCompatibleTextRendering = false,
        };
        left.Controls.Add(kicker);
        left.Controls.Add(OnceTheme.Heading("CONNECT TO ONCE", 22F));

        var intro = OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_.");
        left.Controls.Add(intro);

        var card = new TableLayoutPanel
        {
            ColumnCount = 2,
            RowCount = 4,
            Width = OnceTheme.MaxContentWidth,
            Height = OnceTheme.S(300),
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(24)),
            Margin = new Padding(0, 0, 0, OnceTheme.S(20)),
            GrowStyle = TableLayoutPanelGrowStyle.FixedSize,
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        card.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(54)));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(76)));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(52)));
        card.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var keyLabel = new Label
        {
            Text = "ONCE API KEY",
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Margin = Padding.Empty,
            UseCompatibleTextRendering = false,
        };
        card.Controls.Add(keyLabel, 0, 0);
        card.SetColumnSpan(keyLabel, 2);

        _apiKey = new TextBox
        {
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            PlaceholderText = "once_test_...",
            Font = OnceTheme.Mono(10.5F),
            BackColor = Color.FromArgb(4, 13, 18),
            ForeColor = OnceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            UseSystemPasswordChar = true,
            Margin = new Padding(0, OnceTheme.S(12), OnceTheme.S(18), OnceTheme.S(12)),
        };

        var paste = OnceTheme.SecondaryButton("Paste", 150);
        paste.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        paste.Margin = new Padding(0, OnceTheme.S(8), 0, OnceTheme.S(8));
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
            UseCompatibleTextRendering = false,
        };
        showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !showKey.Checked;
        card.Controls.Add(showKey, 0, 2);
        card.SetColumnSpan(showKey, 2);

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = false,
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.TopLeft,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9F),
            Padding = new Padding(0, OnceTheme.S(8), 0, 0),
            Margin = Padding.Empty,
            UseCompatibleTextRendering = false,
        };
        card.Controls.Add(safeHint, 0, 3);
        card.SetColumnSpan(safeHint, 2);
        left.Controls.Add(card);

        var help = new LinkLabel
        {
            Text = "Need a key? Open the Once evaluation page and copy your API key.",
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.MaxContentWidth, 0),
            LinkColor = OnceTheme.Accent,
            ActiveLinkColor = Color.FromArgb(90, 255, 190),
            VisitedLinkColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, OnceTheme.S(4), 0, OnceTheme.S(26)),
            UseCompatibleTextRendering = false,
        };
        left.Controls.Add(help);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, OnceTheme.S(10), 0, 0),
            Padding = Padding.Empty,
        };
        var cancel = OnceTheme.SecondaryButton("Cancel", 190);
        cancel.DialogResult = DialogResult.Cancel;
        var connect = OnceTheme.PrimaryButton("Continue  →", 235);
        connect.DialogResult = DialogResult.OK;
        cancel.Margin = new Padding(0, 0, OnceTheme.S(14), 0);
        connect.Margin = Padding.Empty;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        left.Controls.Add(buttons);

        var status = BuildStatusPanel();
        status.Dock = DockStyle.Fill;
        status.Margin = new Padding(0, OnceTheme.S(12), 0, OnceTheme.S(12));

        main.Controls.Add(left, 0, 0);
        main.Controls.Add(status, 2, 0);
        body.Controls.Add(main);

        var layingOut = false;
        void LayoutContent()
        {
            if (layingOut || body.ClientSize.Width <= 0)
            {
                return;
            }

            layingOut = true;
            try
            {
                var narrow = body.ClientSize.Width < 1150;
                status.Visible = !narrow;
                main.ColumnStyles[0].SizeType = SizeType.Percent;
                main.ColumnStyles[0].Width = narrow ? 100F : 62F;
                main.ColumnStyles[1].SizeType = SizeType.Absolute;
                main.ColumnStyles[1].Width = narrow ? 0F : OnceTheme.S(34);
                main.ColumnStyles[2].SizeType = SizeType.Percent;
                main.ColumnStyles[2].Width = narrow ? 0F : 38F;

                var width = Math.Max(OnceTheme.S(500), left.ClientSize.Width - left.Padding.Horizontal - OnceTheme.S(16));
                width = Math.Min(OnceTheme.MaxContentWidth, width);
                card.Width = width;
                intro.MaximumSize = new Size(width, 0);
                help.MaximumSize = new Size(width, 0);
            }
            finally
            {
                layingOut = false;
            }
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
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(28)),
            MinimumSize = new Size(OnceTheme.S(300), OnceTheme.S(360)),
        };

        var flow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            BackColor = OnceTheme.Surface,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };

        flow.Controls.Add(new Label
        {
            Text = "ONCE / SETUP STATUS",
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(8.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, OnceTheme.S(16)),
            UseCompatibleTextRendering = false,
        });

        flow.Controls.Add(new Label
        {
            Text = "READY TO CONNECT",
            AutoSize = true,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Display(15F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(18)),
            UseCompatibleTextRendering = false,
        });

        flow.Controls.Add(new Label
        {
            Text = "Connect this machine, choose a project, then Once will verify the retry-safety path before setup completes.",
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.S(310), 0),
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(24)),
            UseCompatibleTextRendering = false,
        });

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
                ForeColor = OnceTheme.Text,
                Font = OnceTheme.Body(8.8F),
                Margin = new Padding(0, 0, 0, OnceTheme.S(14)),
                UseCompatibleTextRendering = false,
            });
        }

        flow.Controls.Add(new Label
        {
            Text = "Test build " + OnceTheme.BuildVersion,
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(7.5F, FontStyle.Bold),
            Margin = new Padding(0, OnceTheme.S(24), 0, 0),
            UseCompatibleTextRendering = false,
        });

        panel.Controls.Add(flow);
        return panel;
    }
}
