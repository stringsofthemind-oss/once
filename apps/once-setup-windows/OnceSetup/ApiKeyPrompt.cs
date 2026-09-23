namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        OnceTheme.Apply(this, "Connect to Once", new Size(1360, 860));
        AutoScroll = false;

        var viewport = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = OnceTheme.Background,
            Padding = new Padding(OnceTheme.S(30)),
        };

        var canvas = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = OnceTheme.Background,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        canvas.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62F));
        canvas.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, OnceTheme.S(36)));
        canvas.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38F));
        canvas.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var left = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            Dock = DockStyle.Top,
            BackColor = OnceTheme.Background,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        left.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        AddRow(left, Kicker("ONCE / EXECUTION CORE"));
        AddRow(left, OnceTheme.Heading("CONNECT TO ONCE", 22F), new Padding(0, OnceTheme.S(8), 0, OnceTheme.S(12)));

        var intro = OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_.");
        intro.Margin = new Padding(0, 0, 0, OnceTheme.S(24));
        AddRow(left, intro);

        var card = BuildKeyCard(out _apiKey);
        card.Margin = new Padding(0, 0, 0, OnceTheme.S(22));
        AddRow(left, card);

        var help = new LinkLabel
        {
            Text = "Need a key? Open the Once evaluation page and copy your API key.",
            AutoSize = true,
            LinkColor = OnceTheme.Accent,
            ActiveLinkColor = Color.FromArgb(90, 255, 190),
            VisitedLinkColor = OnceTheme.Accent,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(26)),
            UseCompatibleTextRendering = false,
        };
        AddRow(left, help);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        var cancel = OnceTheme.SecondaryButton("Cancel", 190);
        cancel.DialogResult = DialogResult.Cancel;
        cancel.Margin = new Padding(0, 0, OnceTheme.S(14), 0);

        var connect = OnceTheme.PrimaryButton("Continue  →", 235);
        connect.DialogResult = DialogResult.OK;
        connect.Margin = Padding.Empty;

        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        AddRow(left, buttons);

        var status = BuildStatusPanel();
        status.Dock = DockStyle.Top;
        status.Margin = Padding.Empty;

        canvas.Controls.Add(left, 0, 0);
        canvas.Controls.Add(status, 2, 0);
        viewport.Controls.Add(canvas);

        void Reflow()
        {
            if (viewport.ClientSize.Width <= 0)
            {
                return;
            }

            var available = Math.Max(OnceTheme.S(620), viewport.ClientSize.Width - viewport.Padding.Horizontal);
            var maxCanvas = OnceTheme.S(1320);
            var width = Math.Min(maxCanvas, available);
            var narrow = available < OnceTheme.S(1050);

            canvas.SuspendLayout();
            try
            {
                canvas.MinimumSize = new Size(width, 0);
                canvas.MaximumSize = new Size(width, 0);
                canvas.Left = Math.Max(viewport.Padding.Left, (viewport.ClientSize.Width - width) / 2);
                canvas.Top = viewport.Padding.Top;

                status.Visible = !narrow;
                canvas.ColumnStyles[0].Width = narrow ? 100F : 62F;
                canvas.ColumnStyles[1].SizeType = SizeType.Absolute;
                canvas.ColumnStyles[1].Width = narrow ? 0F : OnceTheme.S(36);
                canvas.ColumnStyles[2].Width = narrow ? 0F : 38F;

                var leftWidth = narrow
                    ? width
                    : Math.Max(OnceTheme.S(560), (int)Math.Round((width - OnceTheme.S(36)) * 0.62));
                left.MinimumSize = new Size(leftWidth, 0);
                left.MaximumSize = new Size(leftWidth, 0);
                card.MinimumSize = new Size(leftWidth, 0);
                card.MaximumSize = new Size(leftWidth, 0);
                intro.MaximumSize = new Size(leftWidth, 0);
                help.MaximumSize = new Size(leftWidth, 0);
            }
            finally
            {
                canvas.ResumeLayout(true);
            }
        }

        viewport.SizeChanged += (_, _) => Reflow();

        Controls.Add(OnceTheme.CreateChrome(viewport, 1));
        AcceptButton = connect;
        CancelButton = cancel;

        Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(this);
            Reflow();
            _apiKey.Focus();
        };
    }

    private static TableLayoutPanel BuildKeyCard(out TextBox apiKey)
    {
        var card = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(24)),
            Margin = Padding.Empty,
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        var label = new Label
        {
            Text = "ONCE API KEY",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, OnceTheme.S(12)),
            UseCompatibleTextRendering = false,
        };
        AddRow(card, label);

        var entry = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            Dock = DockStyle.Top,
            Margin = new Padding(0, 0, 0, OnceTheme.S(14)),
            Padding = Padding.Empty,
            BackColor = OnceTheme.Surface,
        };
        entry.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        entry.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        entry.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var keyBox = new TextBox
        {
            Dock = DockStyle.Fill,
            PlaceholderText = "once_test_...",
            Font = OnceTheme.Mono(10.5F),
            BackColor = Color.FromArgb(4, 13, 18),
            ForeColor = OnceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            UseSystemPasswordChar = true,
            Margin = new Padding(0, OnceTheme.S(7), OnceTheme.S(16), OnceTheme.S(7)),
        };

        var paste = OnceTheme.SecondaryButton("Paste", 150);
        paste.Margin = Padding.Empty;
        paste.Click += (_, _) =>
        {
            try
            {
                var clipboardText = Clipboard.GetText()?.Trim() ?? string.Empty;
                if (clipboardText.Length > 0)
                {
                    keyBox.Text = clipboardText;
                    keyBox.SelectionStart = keyBox.TextLength;
                }
            }
            catch
            {
                // Manual paste remains available.
            }
            keyBox.Focus();
        };

        entry.Controls.Add(keyBox, 0, 0);
        entry.Controls.Add(paste, 1, 0);
        AddRow(card, entry);

        var showKey = new CheckBox
        {
            Text = "Show key",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            BackColor = OnceTheme.Surface,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(10)),
            UseCompatibleTextRendering = false,
        };
        showKey.CheckedChanged += (_, _) => keyBox.UseSystemPasswordChar = !showKey.Checked;
        AddRow(card, showKey);

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9F),
            Margin = Padding.Empty,
            MaximumSize = new Size(OnceTheme.S(920), 0),
            UseCompatibleTextRendering = false,
        };
        AddRow(card, safeHint);

        apiKey = keyBox;
        return card;
    }

    private static Panel BuildStatusPanel()
    {
        var panel = new Panel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(28)),
            MinimumSize = new Size(OnceTheme.S(330), OnceTheme.S(390)),
        };

        var flow = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            Dock = DockStyle.Top,
            BackColor = OnceTheme.Surface,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        flow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        AddRow(flow, new Label
        {
            Text = "ONCE / SETUP STATUS",
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(8.5F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, OnceTheme.S(16)),
            UseCompatibleTextRendering = false,
        });

        AddRow(flow, new Label
        {
            Text = "READY TO CONNECT",
            AutoSize = true,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Display(15F),
            Margin = new Padding(0, 0, 0, OnceTheme.S(18)),
            UseCompatibleTextRendering = false,
        });

        AddRow(flow, new Label
        {
            Text = "Connect this machine, choose a project, then Once verifies the retry-safety path before setup completes.",
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
            AddRow(flow, new Label
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

        AddRow(flow, new Label
        {
            Text = "Test build " + OnceTheme.BuildVersion,
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(7.5F, FontStyle.Bold),
            Margin = new Padding(0, OnceTheme.S(20), 0, 0),
            UseCompatibleTextRendering = false,
        });

        panel.Controls.Add(flow);
        return panel;
    }

    private static Label Kicker(string text)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Margin = Padding.Empty,
            UseCompatibleTextRendering = false,
        };
    }

    private static void AddRow(TableLayoutPanel table, Control control, Padding? margin = null)
    {
        var row = table.RowCount++;
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        control.Margin = margin ?? control.Margin;
        table.Controls.Add(control, 0, row);
    }
}
