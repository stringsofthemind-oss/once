namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        OnceTheme.Apply(this, "Connect to Once", new Size(1360, 860));
        AutoScroll = false;

        var body = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(OnceTheme.S(72), OnceTheme.S(40), OnceTheme.S(72), OnceTheme.S(48)),
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
        body.Controls.Add(kicker);
        body.Controls.Add(OnceTheme.Heading("CONNECT TO ONCE", 27F));

        var intro = OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_.");
        body.Controls.Add(intro);

        var card = new TableLayoutPanel
        {
            ColumnCount = 2,
            RowCount = 3,
            Width = OnceTheme.MaxContentWidth,
            Height = OnceTheme.S(220),
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(22)),
            Margin = new Padding(0, 0, 0, OnceTheme.S(18)),
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        card.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(38)));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, OnceTheme.S(70)));
        card.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var keyLabel = new Label
        {
            Text = "ONCE API KEY",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0),
        };
        card.Controls.Add(keyLabel, 0, 0);
        card.SetColumnSpan(keyLabel, 2);

        _apiKey = new TextBox
        {
            Dock = DockStyle.Fill,
            PlaceholderText = "once_test_...",
            Font = OnceTheme.Mono(11F),
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

        var hintRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            AutoSize = false,
            BackColor = OnceTheme.Surface,
            Margin = Padding.Empty,
            Padding = new Padding(0, OnceTheme.S(8), 0, 0),
        };

        var showKey = new CheckBox
        {
            Text = "Show key",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            BackColor = OnceTheme.Surface,
            Font = OnceTheme.Body(9.5F),
            Margin = new Padding(0, 0, OnceTheme.S(22), 0),
        };
        showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !showKey.Checked;

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F),
            Margin = Padding.Empty,
        };

        hintRow.Controls.Add(showKey);
        hintRow.Controls.Add(safeHint);
        card.Controls.Add(hintRow, 0, 2);
        card.SetColumnSpan(hintRow, 2);
        body.Controls.Add(card);

        var help = new LinkLabel
        {
            Text = "Need a key? Return to the Once evaluation page and click Copy API key.",
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.MaxContentWidth, 0),
            LinkColor = OnceTheme.Accent,
            ActiveLinkColor = Color.FromArgb(90, 255, 190),
            VisitedLinkColor = OnceTheme.Accent,
            Font = OnceTheme.Body(10F),
            Margin = new Padding(0, OnceTheme.S(6), 0, OnceTheme.S(26)),
        };
        body.Controls.Add(help);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, OnceTheme.S(12), 0, 0),
        };
        var cancel = OnceTheme.SecondaryButton("Cancel", 150);
        cancel.DialogResult = DialogResult.Cancel;
        var connect = OnceTheme.PrimaryButton("Continue  →", 190);
        connect.DialogResult = DialogResult.OK;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        body.Controls.Add(buttons);

        void LayoutContent()
        {
            var width = OnceTheme.ContentWidth(body);
            card.Width = width;
            intro.MaximumSize = new Size(width, 0);
            help.MaximumSize = new Size(width, 0);
            safeHint.MaximumSize = new Size(Math.Max(OnceTheme.S(260), width - OnceTheme.S(230)), 0);
            body.PerformLayout();
        }

        body.SizeChanged += (_, _) => LayoutContent();

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
}
