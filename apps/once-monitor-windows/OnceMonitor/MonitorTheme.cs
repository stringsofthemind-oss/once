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
    internal static readonly Color Heartbeat = Color.FromArgb(255, 48, 64);
    internal static readonly Color Activity = Color.FromArgb(67, 215, 255);

    internal static readonly Font Heading = new("Segoe UI Semibold", 14f, FontStyle.Bold);
    internal static readonly Font Subheading = new("Segoe UI Semibold", 10.5f, FontStyle.Bold);
    internal static readonly Font Body = new("Segoe UI", 9.5f, FontStyle.Regular);
    internal static readonly Font Small = new("Segoe UI", 8.5f, FontStyle.Regular);
    internal static readonly Font Mono = new("Consolas", 8.5f, FontStyle.Regular);

    internal static Button Button(string text, EventHandler click)
    {
        var button = new Button
        {
            Text = text,
            FlatStyle = FlatStyle.Flat,
            BackColor = SurfaceRaised,
            ForeColor = Text,
            Font = Body,
            Height = 34,
            AutoSize = true,
            Padding = new Padding(10, 0, 10, 0),
            Cursor = Cursors.Hand,
        };
        button.FlatAppearance.BorderColor = Border;
        button.FlatAppearance.MouseOverBackColor = AccentDeep;
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
            MaximumSize = new Size(370, 0),
        };
    }

    internal static Panel Card()
    {
        return new Panel
        {
            BackColor = Surface,
            Padding = new Padding(12),
            Margin = new Padding(0, 0, 0, 10),
        };
    }

    internal static Color StatusColor(TrayVisualState state) => state switch
    {
        TrayVisualState.Activity => Activity,
        TrayVisualState.Attention => Warning,
        TrayVisualState.Problem => Danger,
        _ => Accent,
    };
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

            using var badge = RoundedRectangle(new RectangleF(2, 2, 28, 28), 7);
            using var badgeBrush = new SolidBrush(MonitorTheme.AccentDeep);
            using var borderPen = new Pen(MonitorTheme.Border, 1.2f);
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

    private static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }
}

internal sealed class HeartbeatControl : Control
{
    private readonly System.Windows.Forms.Timer _timer;
    private DateTimeOffset _pulseUntil = DateTimeOffset.MinValue;

    internal HeartbeatControl()
    {
        DoubleBuffered = true;
        Height = 44;
        Dock = DockStyle.Top;
        BackColor = MonitorTheme.Background;

        _timer = new System.Windows.Forms.Timer { Interval = 80 };
        _timer.Tick += (_, _) =>
        {
            if (DateTimeOffset.UtcNow >= _pulseUntil)
            {
                _timer.Stop();
            }
            Invalidate();
        };
    }

    internal void Pulse()
    {
        _pulseUntil = DateTimeOffset.UtcNow.AddSeconds(1.2);
        _timer.Start();
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var width = Math.Max(10, ClientSize.Width - 8);
        var y = ClientSize.Height / 2f;
        var points = new[]
        {
            new PointF(4, y),
            new PointF(width * .25f, y),
            new PointF(width * .29f, y - 7),
            new PointF(width * .33f, y + 12),
            new PointF(width * .38f, y - 22),
            new PointF(width * .43f, y + 18),
            new PointF(width * .48f, y - 10),
            new PointF(width * .54f, y),
            new PointF(width, y),
        };

        using var heartbeatPen = new Pen(MonitorTheme.Heartbeat, 2.1f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };
        e.Graphics.DrawLines(heartbeatPen, points);

        if (DateTimeOffset.UtcNow < _pulseUntil)
        {
            using var activityPen = new Pen(MonitorTheme.Activity, 2.6f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
                LineJoin = LineJoin.Round,
            };
            e.Graphics.DrawLines(activityPen, points.Skip(2).Take(5).ToArray());
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
        }
        base.Dispose(disposing);
    }
}
