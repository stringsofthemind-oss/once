namespace OnceSetup;

internal static class OnceTheme
{
    internal static readonly Color Background = Color.FromArgb(4, 9, 13);
    internal static readonly Color Surface = Color.FromArgb(8, 18, 24);
    internal static readonly Color SurfaceRaised = Color.FromArgb(11, 28, 34);
    internal static readonly Color Border = Color.FromArgb(24, 67, 69);
    internal static readonly Color Accent = Color.FromArgb(54, 235, 161);
    internal static readonly Color AccentDeep = Color.FromArgb(11, 65, 59);
    internal static readonly Color Text = Color.FromArgb(244, 248, 249);
    internal static readonly Color Muted = Color.FromArgb(156, 176, 188);
    internal static readonly Color Warning = Color.FromArgb(250, 190, 66);
    internal static readonly Color Danger = Color.FromArgb(244, 94, 103);

    internal static Font Body(float size = 11F, FontStyle style = FontStyle.Regular) =>
        new("Segoe UI", size, style, GraphicsUnit.Point);

    internal static Font Display(float size = 22F) =>
        new("Segoe UI", size, FontStyle.Bold, GraphicsUnit.Point);

    internal static void Apply(Form form, string title, Size? clientSize = null)
    {
        form.Text = title;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.FormBorderStyle = FormBorderStyle.Sizable;
        form.MinimumSize = new Size(760, 560);
        form.ClientSize = clientSize ?? new Size(980, 680);
        form.BackColor = Background;
        form.ForeColor = Text;
        form.Font = Body();
        form.AutoScaleMode = AutoScaleMode.Dpi;
        form.ShowInTaskbar = true;
        form.MaximizeBox = true;
        form.MinimizeBox = true;
    }

    internal static Panel CreateTopBar(string title = "Once Setup")
    {
        var bar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 54,
            BackColor = Color.FromArgb(5, 15, 20),
            Padding = new Padding(18, 10, 18, 8),
        };

        var badge = new Label
        {
            Text = "1x",
            AutoSize = false,
            Width = 36,
            Height = 30,
            TextAlign = ContentAlignment.MiddleCenter,
            BackColor = AccentDeep,
            ForeColor = Accent,
            Font = Body(10F, FontStyle.Bold),
        };

        var name = new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = Text,
            Font = Body(10.5F, FontStyle.Bold),
            Location = new Point(62, 17),
        };

        bar.Controls.Add(badge);
        bar.Controls.Add(name);
        return bar;
    }

    internal static Control CreateStepBar(int activeStep)
    {
        return new StepBar(activeStep)
        {
            Dock = DockStyle.Top,
            Height = 74,
            Margin = new Padding(0),
        };
    }

    internal static Label Heading(string text, float size = 22F)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            ForeColor = Text,
            Font = Display(size),
            Margin = new Padding(0, 0, 0, 8),
        };
    }

    internal static Label Paragraph(string text, int maxWidth = 820)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(maxWidth, 0),
            ForeColor = Muted,
            Font = Body(11F),
            Margin = new Padding(0, 0, 0, 16),
        };
    }

    internal static Button PrimaryButton(string text, int width = 180)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = false,
            Width = width,
            Height = 48,
            FlatStyle = FlatStyle.Flat,
            BackColor = Accent,
            ForeColor = Color.FromArgb(2, 18, 16),
            Font = Body(10.5F, FontStyle.Bold),
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(76, 247, 177);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(38, 209, 141);
        return button;
    }

    internal static Button SecondaryButton(string text, int width = 150)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = false,
            Width = width,
            Height = 48,
            FlatStyle = FlatStyle.Flat,
            BackColor = SurfaceRaised,
            ForeColor = Text,
            Font = Body(10.5F, FontStyle.Bold),
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(15, 38, 45);
        return button;
    }

    internal static Panel Card(int height = 92)
    {
        return new Panel
        {
            Height = height,
            Dock = DockStyle.Top,
            BackColor = Surface,
            Padding = new Padding(18),
            Margin = new Padding(0, 0, 0, 12),
        };
    }

    internal static void FitToWorkingArea(Form form)
    {
        var working = Screen.FromControl(form).WorkingArea;
        if (form.Height > working.Height - 60)
        {
            form.Height = Math.Max(form.MinimumSize.Height, working.Height - 60);
        }
        if (form.Width > working.Width - 60)
        {
            form.Width = Math.Max(form.MinimumSize.Width, working.Width - 60);
        }
        form.CenterToScreen();
    }

    private sealed class StepBar : Control
    {
        private readonly int _activeStep;
        private static readonly string[] Steps = ["Connect", "Project", "Install", "Verify", "Complete"];

        internal StepBar(int activeStep)
        {
            _activeStep = Math.Clamp(activeStep, 1, Steps.Length);
            DoubleBuffered = true;
            BackColor = Background;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

            var left = 54F;
            var right = Width - 54F;
            var y = 26F;
            var spacing = (right - left) / (Steps.Length - 1);

            using var pendingPen = new Pen(Border, 2F);
            using var donePen = new Pen(Accent, 2F);
            g.DrawLine(pendingPen, left, y, right, y);
            if (_activeStep > 1)
            {
                g.DrawLine(donePen, left, y, left + spacing * (_activeStep - 1), y);
            }

            for (var i = 0; i < Steps.Length; i++)
            {
                var x = left + spacing * i;
                var state = i + 1;
                var completed = state < _activeStep;
                var active = state == _activeStep;
                var fill = completed || active ? Accent : SurfaceRaised;
                var outline = completed || active ? Accent : Border;

                using var fillBrush = new SolidBrush(fill);
                using var outlinePen = new Pen(outline, active ? 3F : 2F);
                g.FillEllipse(fillBrush, x - 10, y - 10, 20, 20);
                g.DrawEllipse(outlinePen, x - 10, y - 10, 20, 20);

                if (!completed)
                {
                    using var numberFont = Body(8.5F, FontStyle.Bold);
                    using var numberBrush = new SolidBrush(active ? Background : Muted);
                    var n = state.ToString();
                    var nSize = g.MeasureString(n, numberFont);
                    g.DrawString(n, numberFont, numberBrush, x - nSize.Width / 2, y - nSize.Height / 2 + 1);
                }
                else
                {
                    using var tickPen = new Pen(Background, 2F);
                    g.DrawLines(tickPen, [new PointF(x - 4, y), new PointF(x - 1, y + 4), new PointF(x + 5, y - 4)]);
                }

                using var labelFont = Body(8.5F, active ? FontStyle.Bold : FontStyle.Regular);
                using var labelBrush = new SolidBrush(active ? Text : Muted);
                var labelSize = g.MeasureString(Steps[i], labelFont);
                g.DrawString(Steps[i], labelFont, labelBrush, x - labelSize.Width / 2, 46F);
            }
        }
    }
}
