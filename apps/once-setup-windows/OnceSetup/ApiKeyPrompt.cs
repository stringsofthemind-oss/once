namespace OnceSetup;

internal sealed class ApiKeyPrompt : Form
{
    private readonly TextBox _apiKey;

    internal string ApiKey => _apiKey.Text.Trim();

    internal ApiKeyPrompt()
    {
        Text = "Connect Once";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        ClientSize = new Size(620, 245);
        AutoScaleMode = AutoScaleMode.Dpi;

        var messageFont = SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont;
        var title = new Label
        {
            Text = "Paste your Once evaluation API key",
            AutoSize = true,
            Font = new Font(messageFont.FontFamily, 14, FontStyle.Bold),
            Location = new Point(24, 22),
        };

        var help = new Label
        {
            Text = "Once could not read a valid key automatically from the clipboard.\nPaste the key shown on the evaluation page. It begins with once_test_.",
            AutoSize = false,
            Location = new Point(25, 62),
            Size = new Size(565, 54),
        };

        _apiKey = new TextBox
        {
            Location = new Point(28, 124),
            Size = new Size(564, 31),
            PlaceholderText = "once_test_...",
        };

        var paste = new Button
        {
            Text = "Paste from clipboard",
            Location = new Point(28, 178),
            Size = new Size(170, 38),
        };
        paste.Click += (_, _) =>
        {
            try
            {
                var clipboardText = Clipboard.GetText()?.Trim() ?? string.Empty;
                if (clipboardText.Length > 0)
                {
                    _apiKey.Text = clipboardText;
                    _apiKey.SelectionStart = _apiKey.TextLength;
                }
                _apiKey.Focus();
            }
            catch
            {
                // Manual Ctrl+V remains available if clipboard API access is unavailable.
                _apiKey.Focus();
            }
        };

        var cancel = new Button
        {
            Text = "Cancel",
            DialogResult = DialogResult.Cancel,
            Location = new Point(392, 178),
            Size = new Size(95, 38),
        };

        var connect = new Button
        {
            Text = "Continue",
            DialogResult = DialogResult.OK,
            Location = new Point(497, 178),
            Size = new Size(95, 38),
        };

        Controls.Add(title);
        Controls.Add(help);
        Controls.Add(_apiKey);
        Controls.Add(paste);
        Controls.Add(cancel);
        Controls.Add(connect);

        AcceptButton = connect;
        CancelButton = cancel;

        Shown += (_, _) => _apiKey.Focus();
    }
}
