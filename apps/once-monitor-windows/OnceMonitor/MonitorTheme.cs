using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace OnceMonitor;

internal enum TrayVisualState
{
    Ready,
    Activity,
    Attention,
    Problem,
}

internal static class MonitorTheme
{
    // Keep the native Monitor on the same visual tokens as docs/styles.css.
    internal static readonly Color Background = Color.FromArgb(5, 7, 11);       // --bg
    internal static readonly Color Background2 = Color.FromArgb(8, 16, 25);      // --bg2
    internal static readonly Color Surface = Color.FromArgb(10, 17, 26);         // --panel
    internal static readonly Color SurfaceRaised = Color.FromArgb(13, 23, 35);   // --panel2
    internal static readonly Color Border = Color.FromArgb(34, 46, 58);
    internal static readonly Color BorderStrong = Color.FromArgb(53, 69, 84);
    internal static readonly Color Accent = Color.FromArgb(57, 240, 160);         // --green
    internal static readonly Color AccentDeep = Color.FromArgb(13, 54, 42);
    internal static readonly Color AccentWash = Color.FromArgb(10, 35, 29);
    internal static readonly Color Text = Color.FromArgb(245, 248, 251);          // --text
    internal static readonly Color Muted = Color.FromArgb(142, 160, 176);         // --muted
    internal static readonly Color Dim = Color.FromArgb(99, 118, 133);
    internal static readonly Color Warning = Color.FromArgb(255, 186, 98);        // --amber
    internal static readonly Color Danger = Color.FromArgb(255, 104, 120);        // --red
    internal static readonly Color Activity = Color.FromArgb(67, 215, 255);       // --cyan

    // The tray flyout itself is intentionally kept at a moderate physical
    // footprint. Use pixel-unit typography so Windows display scaling does not
    // enlarge the text a second time and force labels/navigation into ellipses.
    internal static readonly Font Brand = new("Segoe UI Semibold", 24f, FontStyle.Bold, GraphicsUnit.Pixel);
    internal static readonly Font Heading = new("Segoe UI Semibold", 21f, FontStyle.Bold, GraphicsUnit.Pixel);
    internal static readonly Font Subheading = new("Segoe UI Semibold", 14f, FontStyle.Bold, GraphicsUnit.Pixel);
    internal static readonly Font Body = new("Segoe UI", 15f, FontStyle.Regular, GraphicsUnit.Pixel);
    internal static readonly Font Small = new("Segoe UI Semibold", 13f, FontStyle.Regular, GraphicsUnit.Pixel);
    internal static readonly Font Mono = new("Consolas", 14f, FontStyle.Regular, GraphicsUnit.Pixel);

    internal static WebsiteButton Button(string text, EventHandler click, bool primary = false)
    {
        var button = new WebsiteButton
        {
            Text = text,
            Font = primary
                ? new Font("Segoe UI Semibold", 15f, FontStyle.Bold, GraphicsUnit.Pixel)
                : Body,
            Height = 42,
            AutoSize = true,
            Padding = new Padding(16, 0, 16, 0),
            Cursor = Cursors.Hand,
            Primary = primary,
        };
        button.Click += click;
        return button;
    }

    internal static Label Label(string text, bool muted = false, bool heading = false)
    {
        return new Label
        {
            Text = text,
            ForeColor = muted ? Muted : Text,
            BackColor = Color.Transparent,
            Font = heading ? Subheading : Body,
            AutoSize = true,
            MaximumSize = new Size(680, 0),
        };
    }

    internal static WebsitePanel Card(int radius = 17)
    {
        return new WebsitePanel
        {
            Radius = radius,
            FillColor = Surface,
            BorderColor = Border,
            BorderWidth = 1f,
            Padding = new Padding(20),
            Margin = new Padding(0, 0, 0, 14),
        };
    }

    internal static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
    {
        var diameter = Math.Max(1f, radius * 2f);
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    internal static void ApplyRoundedRegion(Control control, int radius)
    {
        if (control.Width <= 1 || control.Height <= 1)
        {
            return;
        }

        using var path = RoundedRectangle(
            new RectangleF(0, 0, control.Width, control.Height),
            radius);
        var old = control.Region;
        control.Region = new Region(path);
        old?.Dispose();
    }

    internal static Color StatusColor(TrayVisualState state) => state switch
    {
        TrayVisualState.Activity => Activity,
        TrayVisualState.Attention => Warning,
        TrayVisualState.Problem => Danger,
        _ => Accent,
    };
}

internal sealed class WebsiteBackgroundPanel : Panel
{
    internal WebsiteBackgroundPanel()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var bounds = ClientRectangle;
        if (bounds.Width <= 0 || bounds.Height <= 0)
        {
            return;
        }

        using (var gradient = new LinearGradientBrush(
                   bounds,
                   MonitorTheme.Background,
                   MonitorTheme.Background2,
                   LinearGradientMode.Vertical))
        {
            e.Graphics.FillRectangle(gradient, bounds);
        }

        using var glow = new SolidBrush(Color.FromArgb(9, MonitorTheme.Activity));
        e.Graphics.FillEllipse(glow, bounds.Width - 300, -170, 420, 320);
    }
}

internal class WebsitePanel : Panel
{
    private int _radius = 17;
    private Color _fillColor = MonitorTheme.Surface;
    private Color _borderColor = MonitorTheme.Border;
    private float _borderWidth = 1f;

    internal WebsitePanel()
    {
        DoubleBuffered = true;
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.SupportsTransparentBackColor,
            true);
        BackColor = Color.Transparent;
        Resize += (_, _) => MonitorTheme.ApplyRoundedRegion(this, Radius);
    }

    internal int Radius
    {
        get => _radius;
        set
        {
            _radius = Math.Max(1, value);
            MonitorTheme.ApplyRoundedRegion(this, _radius);
            Invalidate();
        }
    }

    internal Color FillColor
    {
        get => _fillColor;
        set { _fillColor = value; Invalidate(); }
    }

    internal Color BorderColor
    {
        get => _borderColor;
        set { _borderColor = value; Invalidate(); }
    }

    internal float BorderWidth
    {
        get => _borderWidth;
        set { _borderWidth = Math.Max(0f, value); Invalidate(); }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new RectangleF(
            BorderWidth / 2f,
            BorderWidth / 2f,
            Math.Max(1f, Width - BorderWidth),
            Math.Max(1f, Height - BorderWidth));

        using var path = MonitorTheme.RoundedRectangle(rect, Radius);
        using var fill = new SolidBrush(FillColor);
        e.Graphics.FillPath(fill, path);

        if (BorderWidth > 0f)
        {
            using var pen = new Pen(BorderColor, BorderWidth);
            e.Graphics.DrawPath(pen, path);
        }
    }
}

internal sealed class WebsiteButton : Button
{
    private bool _hovered;
    private bool _primary;
    private bool _active;

    internal WebsiteButton()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.SupportsTransparentBackColor,
            true);
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        BackColor = Color.Transparent;
        ForeColor = MonitorTheme.Text;
        TabStop = true;
    }

    internal bool Primary
    {
        get => _primary;
        set { _primary = value; Invalidate(); }
    }

    internal bool Active
    {
        get => _active;
        set { _active = value; Invalidate(); }
    }

    internal int Radius { get; set; } = 12;

    protected override void OnMouseEnter(EventArgs e)
    {
        _hovered = true;
        Invalidate();
        base.OnMouseEnter(e);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        _hovered = false;
        Invalidate();
        base.OnMouseLeave(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new RectangleF(0.5f, 0.5f, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using var path = MonitorTheme.RoundedRectangle(rect, Radius);

        var fillColor = Primary
            ? (_hovered ? Color.FromArgb(76, 244, 176) : MonitorTheme.Accent)
            : Active
                ? MonitorTheme.AccentDeep
                : (_hovered ? MonitorTheme.SurfaceRaised : Color.FromArgb(8, 14, 22));

        var borderColor = Primary
            ? MonitorTheme.Accent
            : Active
                ? Color.FromArgb(78, 169, 135)
                : (_hovered ? Color.FromArgb(74, 101, 121) : MonitorTheme.Border);

        using (var fill = new SolidBrush(Enabled ? fillColor : MonitorTheme.Surface))
        using (var pen = new Pen(borderColor, 1f))
        {
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(pen, path);
        }

        var textColor = !Enabled
            ? MonitorTheme.Dim
            : Primary
                ? Color.FromArgb(4, 18, 11)
                : Active
                    ? MonitorTheme.Accent
                    : MonitorTheme.Text;

        TextRenderer.DrawText(
            e.Graphics,
            Text,
            Font,
            ClientRectangle,
            textColor,
            TextFormatFlags.HorizontalCenter |
            TextFormatFlags.VerticalCenter |
            TextFormatFlags.SingleLine |
            TextFormatFlags.EndEllipsis);
    }
}

internal sealed class WebsitePill : Control
{
    private string _label = "STARTING";
    private Color _accent = MonitorTheme.Muted;

    internal WebsitePill()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.SupportsTransparentBackColor,
            true);
        DoubleBuffered = true;
        Size = new Size(134, 34);
        Font = MonitorTheme.Small;
        BackColor = Color.Transparent;
    }

    internal string Label
    {
        get => _label;
        set { _label = value; Invalidate(); }
    }

    internal Color AccentColor
    {
        get => _accent;
        set { _accent = value; Invalidate(); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new RectangleF(0.5f, 0.5f, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
        using var path = MonitorTheme.RoundedRectangle(rect, Height / 2f);
        using var fill = new SolidBrush(Color.FromArgb(12, 20, 29));
        using var border = new Pen(MonitorTheme.Border, 1f);
        e.Graphics.FillPath(fill, path);
        e.Graphics.DrawPath(border, path);

        using var dot = new SolidBrush(AccentColor);
        e.Graphics.FillEllipse(dot, 12, (Height - 7) / 2f, 7, 7);

        TextRenderer.DrawText(
            e.Graphics,
            Label,
            Font,
            new Rectangle(26, 0, Width - 31, Height),
            MonitorTheme.Muted,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
    }
}

internal static class OnceIconFactory
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    internal static Icon Create(TrayVisualState state)
    {
        using var bitmap = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);

            using var badge = MonitorTheme.RoundedRectangle(new RectangleF(2, 2, 28, 28), 7);
            using var badgeBrush = new SolidBrush(MonitorTheme.AccentDeep);
            using var borderPen = new Pen(MonitorTheme.BorderStrong, 1.2f);
            graphics.FillPath(badgeBrush, badge);
            graphics.DrawPath(borderPen, badge);

            using var font = new Font("Segoe UI Semibold", 10.5f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var textBrush = new SolidBrush(MonitorTheme.Accent);
            using var format = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center,
            };
            graphics.DrawString("1x", font, textBrush, new RectangleF(3, 4, 26, 23), format);

            using var statusBrush = new SolidBrush(MonitorTheme.StatusColor(state));
            using var statusOutline = new Pen(MonitorTheme.Background, 2f);
            graphics.FillEllipse(statusBrush, 22, 22, 8, 8);
            graphics.DrawEllipse(statusOutline, 22, 22, 8, 8);
        }

        var handle = bitmap.GetHicon();
        try
        {
            using var temporary = Icon.FromHandle(handle);
            return (Icon)temporary.Clone();
        }
        finally
        {
            DestroyIcon(handle);
        }
    }
}