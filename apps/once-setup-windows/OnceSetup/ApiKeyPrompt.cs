namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        var messageFont = SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont;

        Text = "Connect Once";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = false;
        ShowInTaskbar = true;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = messageFont;
        AutoScroll = true;
        ClientSize = new Size(860, 610);
        MinimumSize = new Size(700, 500);

        var layout = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Top,
            Padding = new Padding(32),
            ColumnCount = 1,
            RowCount = 6,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        for (var i = 0; i < 6; i++)
        {
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        var title = new Label
        {
            Text = "Connect your Once evaluation",
            AutoSize = true,
            MaximumSize = new Size(760, 0),
            Font = new Font(messageFont.FontFamily, 13F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 18),
        };

        var help = new Label
        {
            Text = "1. Go back to the Once evaluation page and click Copy API key.\n\n2. Return here and click Paste from clipboard.\n\n3. Click Continue.\n\nThe key begins with once_test_.",
            AutoSize = true,
            MaximumSize = new Size(760, 0),
            Margin = new Padding(0, 0, 0, 22),
        };

        var keyLabel = new Label
        {
            Text = "Evaluation API key",
            AutoSize = true,
            Font = new Font(messageFont, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 8),
        };

        _apiKey = new TextBox
        {
            Width = 760,
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            PlaceholderText = "once_test_...",
            Font = new Font("Consolas", 11F),
            Margin = new Padding(0, 0, 0, 18),
        };

        var keyHint = new Label
        {
            Text = "Only the API key is needed here. Do not paste ONCE_API_KEY= or any install commands.",
            AutoSize = true,
            MaximumSize = new Size(760, 0),
            ForeColor = SystemColors.GrayText,
            Margin = new Padding(0, 0, 0, 24),
        };

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Margin = new Padding(0),
        };

        var paste = new Button
        {
            Text = "Paste from clipboard",
            AutoSize = true,
            MinimumSize = new Size(190, 46),
            Margin = new Padding(0, 0, 12, 0),
        };
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
                _apiKey.Focus();
            }
            catch
            {
                _apiKey.Focus();
            }
        };

        var cancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            AutoSize = true,
            MinimumSize = new Size(105, 46),
            Margin = new Padding(0, 0, 12, 0),
        };

        var connect = new Button
        {
            Text = "Continue",
            DialogResult = DialogResult.OK,
            AutoSize = true,
            MinimumSize = new Size(120, 46),
            Margin = new Padding(0),
        };

        buttons.Controls.Add(paste);
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(connect);

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(help, 0, 1);
        layout.Controls.Add(keyLabel, 0, 2);
        layout.Controls.Add(_apiKey, 0, 3);
        layout.Controls.Add(keyHint, 0, 4);
        layout.Controls.Add(buttons, 0, 5);

        Controls.Add(layout);

        AcceptButton = connect;
        CancelButton = cancel;

        Shown += (_, _) =>
        {
            var working = Screen.FromControl(this).WorkingArea;
            if (Height > working.Height - 80)
            {
                Height = Math.Max(MinimumSize.Height, working.Height - 80);
            }
            if (Width > working.Width - 80)
            {
                Width = Math.Max(MinimumSize.Width, working.Width - 80);
            }
            CenterToScreen();
            _apiKey.Focus();
        };
    }
}
