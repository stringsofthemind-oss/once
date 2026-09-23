namespace OnceSetup;

internal sealed class SetupProgressForm : Form
{
    private readonly Label[] _statusLabels;
    private readonly ProgressBar _progress;
    private readonly Label _detail;

    internal SetupProgressForm()
    {
        OnceTheme.Apply(this, "Installing Once", new Size(1360, 860));
        ControlBox = false;
        AutoScroll = false;

        var viewport = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = OnceTheme.Background,
            Padding = new Padding(OnceTheme.S(36)),
        };

        var content = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            BackColor = OnceTheme.Background,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        AddRow(content, OnceTheme.Heading("INSTALLING ONCE", 21F), Bottom(12));
        var intro = OnceTheme.Paragraph("Setting up Once in your project and preparing the safety verification.");
        AddRow(content, intro, Bottom(24));

        var card = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(28)),
            Margin = Padding.Empty,
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

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
                Font = OnceTheme.Body(10F),
                Margin = new Padding(0, 0, 0, OnceTheme.S(16)),
                UseCompatibleTextRendering = false,
            };
            _statusLabels[i] = label;
            AddRow(card, label);
        }

        _progress = new ProgressBar
        {
            Dock = DockStyle.Top,
            Height = OnceTheme.S(18),
            Minimum = 0,
            Maximum = 100,
            Value = 5,
            Style = ProgressBarStyle.Continuous,
            Margin = new Padding(0, OnceTheme.S(8), 0, 0),
        };
        AddRow(card, _progress);
        AddRow(content, card, Bottom(20));

        _detail = new Label
        {
            AutoSize = true,
            ForeColor = OnceTheme.Muted,
            Font = OnceTheme.Body(9.5F),
            Margin = Padding.Empty,
            MaximumSize = new Size(OnceTheme.MaxContentWidth, 0),
            UseCompatibleTextRendering = false,
        };
        AddRow(content, _detail);

        viewport.Controls.Add(content);

        void Reflow()
        {
            if (viewport.ClientSize.Width <= 0)
            {
                return;
            }

            var available = Math.Max(OnceTheme.S(560), viewport.ClientSize.Width - viewport.Padding.Horizontal);
            var width = Math.Min(OnceTheme.S(1040), available);
            content.MinimumSize = new Size(width, 0);
            content.MaximumSize = new Size(width, 0);
            content.Left = Math.Max(viewport.Padding.Left, (viewport.ClientSize.Width - width) / 2);
            content.Top = viewport.Padding.Top;
            card.MinimumSize = new Size(width, 0);
            card.MaximumSize = new Size(width, 0);
            intro.MaximumSize = new Size(width, 0);
            _detail.MaximumSize = new Size(width, 0);
        }

        viewport.SizeChanged += (_, _) => Reflow();

        Controls.Add(OnceTheme.CreateChrome(viewport, 3));
        Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(this);
            Reflow();
            viewport.PerformLayout();
        };
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

    private static Padding Bottom(int value) => new(0, 0, 0, OnceTheme.S(value));

    private static void AddRow(TableLayoutPanel table, Control control, Padding? margin = null)
    {
        var row = table.RowCount++;
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        control.Margin = margin ?? control.Margin;
        table.Controls.Add(control, 0, row);
    }

    private static string StripPrefix(string text)
    {
        return text.Length >= 3 && (text[0] == '✓' || text[0] == '●' || text[0] == '○')
            ? text[3..]
            : text;
    }
}
