namespace OnceSetup;

internal static class OnceTheme
{
    private static readonly float UiScale = CalculateUiScale();

    internal static int MaxContentWidth => S(1120);
    internal static int MaxChromeWidth => S(1240);
    internal static int MaxStepperWidth => S(860);
    internal static string BuildVersion => typeof(OnceTheme).Assembly.GetName().Version?.ToString() ?? "dev";

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

    internal static int S(int value) => Math.Max(1, (int)Math.Round(value * UiScale));
    internal static float F(float value) => value * UiScale;

    internal static Font Body(float size = 11F, FontStyle style = FontStyle.Regular) =>
        new("Segoe UI", F(size), style, GraphicsUnit.Point);

    internal static Font Display(float size = 22F) =>
        new("Segoe UI", F(size), FontStyle.Bold, GraphicsUnit.Point);

    internal static Font Mono(float size = 11F) =>
        new("Consolas", F(size), FontStyle.Regular, GraphicsUnit.Point);

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
        form.AutoScaleMode = AutoScaleMode.None;
        form.ShowInTaskbar = true;
        form.MaximizeBox = true;
        form.MinimizeBox = true;
    }

    internal static Control CreateChrome(Control body, int? activeStep, string title = "Once Setup")
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = activeStep.HasValue ? 3 : 2,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            BackColor = Background,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, S(94)));
        if (activeStep.HasValue)
        {
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, S(90)));
        }
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));

        var top = CreateTopBar(title);
        top.Dock = DockStyle.Fill;
        root.Controls.Add(top, 0, 0);

        var bodyRow = 1;
        if (activeStep.HasValue)
        {
            var steps = CreateStepBar(activeStep.Value);
            steps.Dock = DockStyle.Fill;
            root.Controls.Add(steps, 0, 1);
            bodyRow = 2;
        }

        body.Dock = DockStyle.Fill;
        root.Controls.Add(body, 0, bodyRow);
        return root;
    }

    internal static Control CreateTopBar(string title = "Once Setup") => new BrandBar(title);

    internal static Control CreateStepBar(int activeStep)
    {
        return new StepBar(activeStep)
        {
            Margin = Padding.Empty,
        };
    }

    internal static Label Heading(string text, float size = 21F)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            ForeColor = Text,
            Font = Display(size),
            Margin = new Padding(0, 0, 0, S(12)),
            UseCompatibleTextRendering = false,
        };
    }

    internal static Label Paragraph(string text, int? maxWidth = null)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            MaximumSize = new Size(maxWidth ?? MaxContentWidth, 0),
            ForeColor = Muted,
            Font = Body(10.5F),
            Margin = new Padding(0, 0, 0, S(20)),
            UseCompatibleTextRendering = false,
        };
    }

    internal static Button PrimaryButton(string text, int width = 180)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(S(width), S(60)),
            FlatStyle = FlatStyle.Flat,
            BackColor = Accent,
            ForeColor = Color.FromArgb(2, 18, 16),
            Font = Body(10.5F, FontStyle.Bold),
            Cursor = Cursors.Hand,
            Padding = new Padding(S(28), S(10), S(28), S(10)),
            TextAlign = ContentAlignment.MiddleCenter,
            UseCompatibleTextRendering = false,
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
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(S(width), S(60)),
            FlatStyle = FlatStyle.Flat,
            BackColor = SurfaceRaised,
            ForeColor = Text,
            Font = Body(10.5F, FontStyle.Bold),
            Cursor = Cursors.Hand,
            Padding = new Padding(S(28), S(10), S(28), S(10)),
            TextAlign = ContentAlignment.MiddleCenter,
            UseCompatibleTextRendering = false,
        };
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(15, 38, 45);
        return button;
    }

    internal static int ContentWidth(Control host, int? maxWidth = null)
    {
        var available = host.ClientSize.Width - host.Padding.Horizontal - S(24);
        return Math.Max(S(320), Math.Min(maxWidth ?? MaxContentWidth, available));
    }

    internal static void FitToWorkingArea(Form form)
    {
        var working = Screen.FromControl(form).WorkingArea;
        var targetWidth = Math.Max(form.MinimumSize.Width, (int)Math.Round(working.Width * 0.92));
        var targetHeight = Math.Max(form.MinimumSize.Height, (int)Math.Round(working.Height * 0.90));
        targetWidth = Math.Min(targetWidth, Math.Max(1, working.Width - 24));
        targetHeight = Math.Min(targetHeight, Math.Max(1, working.Height - 24));

        form.StartPosition = FormStartPosition.Manual;
        form.Bounds = new Rectangle(
            working.Left + Math.Max(0, (working.Width - targetWidth) / 2),
            working.Top + Math.Max(0, (working.Height - targetHeight) / 2),
            targetWidth,
            targetHeight);
    }

    private static float CalculateUiScale()
    {
        var scale = 1F;
        try
        {
            using var graphics = Graphics.FromHwnd(IntPtr.Zero);
            scale = Math.Max(scale, graphics.DpiX / 96F);
        }
        catch
        {
            // Resolution fallback below still gives sensible sizing.
        }

        try
        {
            var working = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
            var resolutionScale = Math.Min(working.Width / 1920F, working.Height / 1080F);
            scale = Math.Max(scale, resolutionScale);
        }
        catch
        {
            // Keep the DPI-derived/default value.
        }

        return Math.Clamp(scale, 1F, 1.50F);
    }

    private sealed class BrandBar : Control
    {
        private readonly string _title;

        internal BrandBar(string title)
        {
            _title = title;
            DoubleBuffered = true;
            BackColor = Color.FromArgb(5, 15, 20);
            Margin = Padding.Empty;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.Clear(BackColor);

            var available = Math.Max(S(360), Width - S(48));
            var span = Math.Min(MaxChromeWidth, available);
            var left = (Width - span) / 2;

            var badgeWidth = S(46);
            var badgeHeight = S(38);
            var badgeTop = Math.Max(S(12), (Height - badgeHeight) / 2);
            var badgeRect = new Rectangle(left, badgeTop, badgeWidth, badgeHeight);

            using (var badgeBrush = new SolidBrush(AccentDeep))
            {
                g.FillRectangle(badgeBrush, badgeRect);
            }

            using var badgeFont = Body(10.5F, FontStyle.Bold);
            TextRenderer.DrawText(
                g,
                "1x",
                badgeFont,
                badgeRect,
                Accent,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);

            using var titleFont = Body(12F, FontStyle.Bold);
            var titleLeft = badgeRect.Right + S(18);
            var titleRect = new Rectangle(titleLeft, 0, Math.Max(S(240), span / 2), Height);
            TextRenderer.DrawText(
                g,
                _title,
                titleFont,
                titleRect,
                OnceTheme.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);

            using var buildFont = Body(7.5F, FontStyle.Bold);
            var buildRect = new Rectangle(left + span / 2, 0, span / 2, Height);
            TextRenderer.DrawText(
                g,
                "TEST BUILD  " + BuildVersion,
                buildFont,
                buildRect,
                Muted,
                TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        }
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

            var available = Math.Max(S(360), Width - S(72));
            var span = Math.Min(MaxStepperWidth, available);
            var left = (Width - span) / 2F;
            var right = left + span;
            var y = S(24);
            var spacing = Math.Max(1F, (right - left) / (Steps.Length - 1));

            using var pendingPen = new Pen(Border, Math.Max(2F, F(1.5F)));
            using var donePen = new Pen(Accent, Math.Max(2F, F(1.5F)));
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
                var radius = S(10);

                using var fillBrush = new SolidBrush(fill);
                using var outlinePen = new Pen(outline, active ? Math.Max(3F, F(2F)) : Math.Max(2F, F(1.5F)));
                g.FillEllipse(fillBrush, x - radius, y - radius, radius * 2, radius * 2);
                g.DrawEllipse(outlinePen, x - radius, y - radius, radius * 2, radius * 2);

                if (!completed)
                {
                    using var numberFont = Body(8F, FontStyle.Bold);
                    using var numberBrush = new SolidBrush(active ? Background : Muted);
                    var n = state.ToString();
                    var nSize = g.MeasureString(n, numberFont);
                    g.DrawString(n, numberFont, numberBrush, x - nSize.Width / 2, y - nSize.Height / 2 + F(0.5F));
                }
                else
                {
                    using var tickPen = new Pen(Background, Math.Max(2F, F(1.5F)));
                    g.DrawLines(tickPen,
                    [
                        new PointF(x - S(4), y),
                        new PointF(x - S(1), y + S(3)),
                        new PointF(x + S(5), y - S(4)),
                    ]);
                }

                using var labelFont = Body(8.5F, active ? FontStyle.Bold : FontStyle.Regular);
                using var labelBrush = new SolidBrush(active ? OnceTheme.Text : Muted);
                var labelSize = g.MeasureString(Steps[i], labelFont);
                g.DrawString(Steps[i], labelFont, labelBrush, x - labelSize.Width / 2, S(47));
            }
        }
    }
}
