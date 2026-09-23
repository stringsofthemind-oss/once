namespace OnceSetup;

internal static class OnceTheme
{
    internal const int MaxContentWidth = 1180;

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
        form.MinimumSize = new Size(900, 640);
        form.ClientSize = clientSize ?? new Size(1360, 860);
        form.BackColor = Background;
        form.ForeColor = Text;
        form.Font = Body();

        // The old DPI autoscaling doubled fixed WinForms coordinates at high
        // Windows display scaling, then the form was shrunk back to the screen.
        // That produced the clipping seen on the 200% display. Keep layout
        // coordinates stable and fit the shell itself to the usable desktop.
        form.AutoScaleMode = AutoScaleMode.None;

        form.ShowInTaskbar = true;
        form.MaximizeBox = true;
        form.MinimizeBox = true;
    }

    internal static Panel CreateTopBar(string title = "Once Setup")
    {
        var bar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 58,
            BackColor = Color.FromArgb(5, 15, 20),
            Padding = new Padding(20, 12, 20, 8),
        };

        var badge = new Label
        {
            Text = "1x",
            AutoSize = false,
            Width = 38,
            Height = 32,
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
            Font = Body(11F, FontStyle.Bold),
            Location = new Point(66, 18),
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
            Height = 82,
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
            Margin = new Padding(0, 0, 0, 10),
        };
    }

    internal static Label Paragraph(string text, int maxWidth = MaxContentWidth)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(maxWidth, 0),
            ForeColor = Muted,
            Font = Body(11F),
            Margin = new Padding(0, 0, 0, 18),
        };
    }

    internal static Button PrimaryButton(string text, int width = 180)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = false,
            Width = width,
            Height = 50,
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
            Height = 50,
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

    internal static int ContentWidth(Control host, int maxWidth = MaxContentWidth)
    {
        var available = host.ClientSize.Width - host.Padding.Horizontal - 24;
        return Math.Max(320, Math.Min(maxWidth, available));
    }

    internal static void FitToWorkingArea(Form form)
    {
        var working = Screen.FromControl(form).WorkingArea;

        // Use almost the full usable desktop. This is intentionally much larger
        // than the old 980x680 shell while still leaving a small visual margin.
        var targetWidth = Math.Max(form.MinimumSize.Width, (int)Math.Round(working.Width * 0.94));
        var targetHeight = Math.Max(form.MinimumSize.Height, (int)Math.Round(working.Height * 0.92));
        targetWidth = Math.Min(targetWidth, Math.Max(1, working.Width - 24));
        targetHeight = Math.Min(targetHeight, Math.Max(1, working.Height - 24));

        form.StartPosition = FormStartPosition.Manual;
        form.Bounds = new Rectangle(
            working.Left + Math.Max(0, (working.Width - targetWidth) / 2),
            working.Top + Math.Max(0, (working.Height - targetHeight) / 2),
            targetWidth,
            targetHeight);
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

            var left = Math.Min(90F, Width * 0.08F);
            var right = Width - left;
            var y = 28F;
            var spacing = Math.Max(1F, (right - left) / (Steps.Length - 1));

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
                g.FillEllipse(fillBrush, x - 11, y - 11, 22, 22);
                g.DrawEllipse(outlinePen, x - 11, y - 11, 22, 22);

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

                using var labelFont = Body(9F, active ? FontStyle.Bold : FontStyle.Regular);
                using var labelBrush = new SolidBrush(active ? OnceTheme.Text : Muted);
                var labelSize = g.MeasureString(Steps[i], labelFont);
                g.DrawString(Steps[i], labelFont, labelBrush, x - labelSize.Width / 2, 50F);
            }
        }
    }
}
