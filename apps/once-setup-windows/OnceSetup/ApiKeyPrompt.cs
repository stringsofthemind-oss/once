namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        OnceTheme.Apply(this, "Connect to Once", new Size(980, 680));
        AutoScroll = true;

        var body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(54, 26, 54, 32),
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
        body.Controls.Add(OnceTheme.Paragraph(
            "Paste your evaluation API key to connect this machine. The key begins with once_test_."));

        var card = new Panel
        {
            Width = 820,
            Height = 176,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(20),
            Margin = new Padding(0, 0, 0, 14),
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
            Width = 610,
            Height = 42,
            Location = new Point(20, 52),
            PlaceholderText = "once_test_...",
            Font = new Font("Consolas", 11F),
            BackColor = Color.FromArgb(4, 13, 18),
            ForeColor = OnceTheme.Text,
            BorderStyle = BorderStyle.FixedSingle,
            UseSystemPasswordChar = true,
        };

        var paste = OnceTheme.SecondaryButton("Paste", 120);
        paste.Location = new Point(650, 49);
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
            Location = new Point(20, 112),
            Font = OnceTheme.Body(9.5F),
        };
        showKey.CheckedChanged += (_, _) => _apiKey.UseSystemPasswordChar = !showKey.Checked;

        var safeHint = new Label
        {
            Text = "Your key stays local to setup and is cleared from the clipboard when setup completes.",
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F),
            Location = new Point(132, 114),
        };

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
        var cancel = OnceTheme.SecondaryButton("Cancel", 140);
        cancel.DialogResult = DialogResult.Cancel;
        var connect = OnceTheme.PrimaryButton("Continue  →", 180);
        connect.DialogResult = DialogResult.OK;
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);
        body.Controls.Add(buttons);

        Controls.Add(body);
        Controls.Add(OnceTheme.CreateStepBar(1));
        Controls.Add(OnceTheme.CreateTopBar());

        AcceptButton = connect;
        CancelButton = cancel;
        Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(this);
            _apiKey.Focus();
        };
    }
}
