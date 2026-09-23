namespace OnceSetup;

internal sealed class SetupProgressForm : Form
{
    private readonly Label[] _statusLabels;
    private readonly ProgressBar _progress;
    private readonly Label _detail;

    internal SetupProgressForm()
    {
        OnceTheme.Apply(this, "Installing Once", new Size(980, 680));
        ControlBox = false;
        AutoScroll = true;

        var body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(54, 28, 54, 32),
            BackColor = OnceTheme.Background,
        };

        body.Controls.Add(OnceTheme.Heading("INSTALLING ONCE"));
        body.Controls.Add(OnceTheme.Paragraph("Setting up Once in your project and preparing the safety verification."));

        var card = new Panel
        {
            Width = 820,
            Height = 300,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(24),
            Margin = new Padding(0, 0, 0, 16),
        };

        var items = new[]
        {
            "Checking system requirements",
            "Installing Once SDK",
            "Configuring project",
            "Verifying Once connection",
            "Running safety proof",
        };

        _statusLabels = new Label[items.Length];
        for (var i = 0; i < items.Length; i++)
        {
            var label = new Label
            {
                Text = "○  " + items[i],
                AutoSize = true,
                ForeColor = OnceTheme.Muted,
                Font = OnceTheme.Body(10.5F),
                Location = new Point(24, 24 + i * 46),
            };
            _statusLabels[i] = label;
            card.Controls.Add(label);
        }

        _progress = new ProgressBar
        {
            Width = 772,
            Height = 12,
            Minimum = 0,
            Maximum = 100,
            Value = 5,
            Style = ProgressBarStyle.Continuous,
            Location = new Point(24, 252),
        };
        card.Controls.Add(_progress);

        _detail = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(820, 0),
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(10F),
            Margin = new Padding(0),
        };

        body.Controls.Add(card);
        body.Controls.Add(_detail);

        Controls.Add(body);
        Controls.Add(OnceTheme.CreateStepBar(3));
        Controls.Add(OnceTheme.CreateTopBar());
        Shown += (_, _) => OnceTheme.FitToWorkingArea(this);
    }

    internal void SetStage(int stage, string? detail = null)
    {
        stage = Math.Clamp(stage, 0, _statusLabels.Length);
        for (var i = 0; i < _statusLabels.Length; i++)
        {
            if (i < stage)
            {
                _statusLabels[i].Text = "✓  " + StripPrefix(_statusLabels[i].Text);
                _statusLabels[i].ForeColor = OnceTheme.Accent;
            }
            else if (i == stage && stage < _statusLabels.Length)
            {
                _statusLabels[i].Text = "●  " + StripPrefix(_statusLabels[i].Text);
                _statusLabels[i].ForeColor = OnceTheme.Text;
            }
            else
            {
                _statusLabels[i].Text = "○  " + StripPrefix(_statusLabels[i].Text);
                _statusLabels[i].ForeColor = OnceTheme.Muted;
            }
        }

        _progress.Value = stage switch
        {
            <= 0 => 5,
            1 => 22,
            2 => 48,
            3 => 68,
            4 => 84,
            _ => 100,
        };
        _detail.Text = detail ?? string.Empty;
        Refresh();
        Application.DoEvents();
    }

    private static string StripPrefix(string text)
    {
        return text.Length >= 3 && (text[0] == '✓' || text[0] == '●' || text[0] == '○')
            ? text[3..]
            : text;
    }
}
