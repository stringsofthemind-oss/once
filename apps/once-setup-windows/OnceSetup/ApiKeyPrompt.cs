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
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        AutoScaleMode = AutoScaleMode.Font;
        Font = messageFont;
        ClientSize = new Size(760, 390);
        MinimumSize = new Size(700, 360);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(30),
            ColumnCount = 1,
            RowCount = 5,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var title = new Label
        {
            Text = "Paste your Once evaluation API key",
            AutoSize = true,
            MaximumSize = new Size(680, 0),
            Font = new Font(messageFont.FontFamily, 16, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 14),
        };

        var help = new Label
        {
            Text = "Once could not read a valid key automatically from the clipboard.\n\nGo back to the Once evaluation page, click Copy API key, then return here. You can use Paste from clipboard below, or click in the box and press Ctrl+V.\n\nPaste only the value beginning with once_test_.",
            AutoSize = true,
            MaximumSize = new Size(680, 0),
            Margin = new Padding(0, 0, 0, 20),
        };

        _apiKey = new TextBox
        {
            Dock = DockStyle.Top,
            PlaceholderText = "once_test_...",
            Font = new Font("Consolas", Math.Max(11F, messageFont.Size + 1F)),
            Margin = new Padding(0, 0, 0, 16),
        };

        var keyHint = new Label
        {
            Text = "Your API key is used only to connect this setup to your Once evaluation.",
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            Margin = new Padding(0, 0, 0, 12),
        };

        var buttons = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            ColumnCount = 3,
            RowCount = 1,
            Margin = new Padding(0),
        };
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        buttons.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var paste = new Button
        {
            Text = "Paste from clipboard",
            AutoSize = true,
            MinimumSize = new Size(190, 44),
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
            MinimumSize = new Size(105, 44),
            Margin = new Padding(0, 0, 12, 0),
        };

        var connect = new Button
        {
            Text = "Continue",
            DialogResult = DialogResult.OK,
            AutoSize = true,
            MinimumSize = new Size(115, 44),
            Margin = new Padding(0),
        };

        buttons.Controls.Add(paste, 0, 0);
        buttons.Controls.Add(cancel, 1, 0);
        buttons.Controls.Add(connect, 2, 0);

        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(help, 0, 1);
        layout.Controls.Add(_apiKey, 0, 2);
        layout.Controls.Add(keyHint, 0, 3);
        layout.Controls.Add(buttons, 0, 4);

        Controls.Add(layout);

        AcceptButton = connect;
        CancelButton = cancel;

        Shown += (_, _) => _apiKey.Focus();
    }
}
