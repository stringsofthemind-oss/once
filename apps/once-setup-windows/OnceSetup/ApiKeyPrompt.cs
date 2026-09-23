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
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(70, 34, 70, 38),
            BackColor = OnceTheme.Background,
        };

        var kicker = new Label
        {
            Text = "ONCE / EXECUTION CORE",
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 12),
        };
        body.Controls.Add(kicker);
        body.Controls.Add(OnceTheme.Heading("CONNECT TO ONCE", 26F));

        var intro = OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_.");
        body.Controls.Add(intro);

        var card = new Panel
        {
            Width = OnceTheme.MaxContentWidth,
            Height = 196,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(20),
            Margin = new Padding(0, 0, 0, 16),
        };

        var keyLabel = new Label
        {
            Text = "ONCE API KEY",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9F, FontStyle.Bold),
            Location = new Point(20, 18),
        };

        _apiKey = new TextBox
        {
            Width = 860,
            Location = new Point(20, 54),
            PlaceholderText = "once_test_...",
            Font = new Font("Consolas", 11F),
            BackColor = Color.FromArgb(4, 13, 18),
            ForeColor = OnceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            UseSystemPasswordChar = true,
        };

        var paste = OnceTheme.SecondaryButton("Paste", 140);
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

        var showKey = new CheckBox
        {
            Text = "Show key",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            BackColor = OnceTheme.Surface,
            Location = new Point(20, 120),
            Font = OnceTheme.Body(9.5F),
        };
        showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !showKey.Checked;

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F),
            Location = new Point(150, 122),
        };

        void LayoutCard()
        {
            var width = OnceTheme.ContentWidth(body);
            card.Width = width;
            var pasteWidth = 140;
            var gap = 18;
            _apiKey.Width = Math.Max(320, width - 40 - pasteWidth - gap);
            paste.Location = new Point(20 + _apiKey.Width + gap, 50);
            safeHint.MaximumSize = new Size(Math.Max(240, width - 175), 0);
            intro.MaximumSize = new Size(width, 0);
        }

        card.Controls.Add(keyLabel);
        card.Controls.Add(_apiKey);
        card.Controls.Add(paste);
        card.Controls.Add(showKey);
        card.Controls.Add(safeHint);
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
            Margin = new Padding(0, 4, 0, 22),
        };
        body.Controls.Add(help);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, 12, 0, 0),
        };
        var cancel = OnceTheme.SecondaryButton("Cancel", 150);
        cancel.DialogResult = DialogResult.Cancel;
        var connect = OnceTheme.PrimaryButton("Continue  →", 190);
        connect.DialogResult = DialogResult.OK;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        body.Controls.Add(buttons);

        body.SizeChanged += (_, _) => LayoutCard();

        Controls.Add(body);
        Controls.Add(OnceTheme.CreateStepBar(1));
        Controls.Add(OnceTheme.CreateTopBar());

        AcceptButton = connect;
        CancelButton = cancel;
        Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(this);
            LayoutCard();
            body.PerformLayout();
            _apiKey.Focus();
        };
    }
}
