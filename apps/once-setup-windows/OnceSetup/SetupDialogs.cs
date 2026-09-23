namespace OnceSetup;

internal enum ProjectMode
{
    Cancel,
    Demo,
    Existing,
}

internal static class SetupDialogs
{
    private const string FullWidthTag = "once-full-width";

    internal static ProjectMode ChooseProjectMode()
    {
        using var form = CreateShell("Choose a project", 2, new Size(1360, 860));
        var body = BodyPanel();
        body.Controls.Add(OnceTheme.Heading("CHOOSE A PROJECT"));
        body.Controls.Add(OnceTheme.Paragraph("Set up Once in a safe demo project or connect an existing Node.js project."));

        var demo = ChoiceCard(
            "Create a safe demo project",
            "Recommended for a first evaluation. We'll create an isolated project and run the retry-suppression proof.",
            recommended: true);
        var existing = ChoiceCard(
            "Use my existing Node.js project",
            "Choose a project folder that already contains package.json. Once will not modify your application source code.",
            recommended: false);

        var result = ProjectMode.Cancel;
        demo.Click += (_, _) => { result = ProjectMode.Demo; form.DialogResult = DialogResult.OK; form.Close(); };
        existing.Click += (_, _) => { result = ProjectMode.Existing; form.DialogResult = DialogResult.OK; form.Close(); };
        foreach (Control c in demo.Controls)
        {
            c.Click += (_, _) => demo.PerformClick();
        }
        foreach (Control c in existing.Controls)
        {
            c.Click += (_, _) => existing.PerformClick();
        }

        body.Controls.Add(demo);
        body.Controls.Add(existing);

        var buttons = ButtonRow();
        var cancel = OnceTheme.SecondaryButton("Cancel", 140);
        cancel.Click += (_, _) => form.Close();
        buttons.Controls.Add(cancel);
        body.Controls.Add(buttons);

        form.Controls.Add(body);
        form.Controls.Add(OnceTheme.CreateStepBar(2));
        form.Controls.Add(OnceTheme.CreateTopBar());
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            body.PerformLayout();
        };
        form.ShowDialog();
        return result;
    }

    internal static bool ConfirmSetup(string root, bool isDemo)
    {
        using var form = CreateShell("Ready to install", 3, new Size(1360, 860));
        var body = BodyPanel();
        body.Controls.Add(OnceTheme.Heading("READY TO INSTALL ONCE"));
        body.Controls.Add(OnceTheme.Paragraph("Once will set up the selected folder using the same guarded path you just evaluated."));

        body.Controls.Add(InfoCard("Selected folder", root));

        var actions = isDemo
            ? "✓ Install @once-agent/sdk\n✓ Save the evaluation key to .env\n✓ Add .env to .gitignore\n✓ Verify the Once connection\n✓ Run the safe retry-suppression demo"
            : "✓ Install @once-agent/sdk\n✓ Save the evaluation key to .env\n✓ Add .env to .gitignore\n✓ Verify the Once connection";
        body.Controls.Add(InfoCard("What Once will do", actions));
        body.Controls.Add(OnceTheme.Paragraph("Once will not modify your application source code."));

        var accepted = false;
        var buttons = ButtonRow();
        var back = OnceTheme.SecondaryButton("Cancel", 150);
        var install = OnceTheme.PrimaryButton("Install Once  →", 200);
        back.Click += (_, _) => form.Close();
        install.Click += (_, _) => { accepted = true; form.DialogResult = DialogResult.OK; form.Close(); };
        buttons.Controls.Add(back);
        buttons.Controls.Add(install);
        body.Controls.Add(buttons);

        form.Controls.Add(body);
        form.Controls.Add(OnceTheme.CreateStepBar(3));
        form.Controls.Add(OnceTheme.CreateTopBar());
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            body.PerformLayout();
        };
        form.ShowDialog();
        return accepted;
    }

    internal static bool ConfirmKeyReplacement()
    {
        return ShowDecision(
            "Existing Once key detected",
            "THIS PROJECT ALREADY HAS ONCE",
            "A different ONCE_API_KEY already exists in this project's .env file. Replace it with the evaluation key?",
            "Replace key",
            "Cancel",
            OnceTheme.Warning);
    }

    internal static bool AskOpenNodeDownload()
    {
        return ShowDecision(
            "Node.js required",
            "NODE.JS 18+ REQUIRED",
            "Once automatic setup needs Node.js 18 or newer, but Node.js was not found on this computer.",
            "Open Node.js download",
            "Cancel",
            OnceTheme.Warning);
    }

    internal static bool AskChooseAnotherProject()
    {
        return ShowDecision(
            "Choose another project",
            "PACKAGE.JSON NOT FOUND",
            "That folder does not contain package.json, so Once cannot safely identify it as a Node.js project.",
            "Choose another folder",
            "Cancel",
            OnceTheme.Warning);
    }

    internal static void ShowError(string heading, string message)
    {
        ShowNotice("Once Setup", heading, message, OnceTheme.Danger, "Try again");
    }

    internal static void ShowWarning(string heading, string message)
    {
        ShowNotice("Once Setup", heading, message, OnceTheme.Warning, "OK");
    }

    internal static void ShowCompletion(string root, bool isDemo)
    {
        using var form = CreateShell("Once Setup complete", 5, new Size(1360, 860));
        var body = BodyPanel();

        var badge = new Label
        {
            Text = "1x",
            Width = 86,
            Height = 68,
            TextAlign = ContentAlignment.MiddleCenter,
            BackColor = OnceTheme.AccentDeep,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(18F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 18),
        };
        body.Controls.Add(badge);
        body.Controls.Add(OnceTheme.Heading("ONCE IS READY", 26F));
        body.Controls.Add(OnceTheme.Paragraph("Installed, connected, and verified. You're all set."));

        var statusText = isDemo
            ? "✓ API connection — Connected\n✓ Project — Demo project\n✓ Safety behavior — Verified, duplicate suppressed\n✓ Side effects — Stayed at 1"
            : "✓ API connection — Connected\n✓ SDK — Installed\n✓ Environment — Key stored in .env\n✓ Source files — Unchanged";
        body.Controls.Add(InfoCard("Verification", statusText));
        body.Controls.Add(InfoCard(isDemo ? "Demo folder" : "Project", root));

        var buttons = ButtonRow();
        var openFolder = OnceTheme.SecondaryButton("Open project folder", 200);
        openFolder.Click += (_, _) =>
        {
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = root,
                    UseShellExecute = true,
                });
            }
            catch
            {
                // Completion remains successful even if Explorer cannot be opened.
            }
        };
        var finish = OnceTheme.PrimaryButton("Finish setup  →", 190);
        finish.Click += (_, _) => form.Close();
        buttons.Controls.Add(openFolder);
        buttons.Controls.Add(finish);
        body.Controls.Add(buttons);

        form.Controls.Add(body);
        form.Controls.Add(OnceTheme.CreateStepBar(5));
        form.Controls.Add(OnceTheme.CreateTopBar());
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            body.PerformLayout();
        };
        form.ShowDialog();
    }

    private static bool ShowDecision(
        string title,
        string heading,
        string message,
        string acceptText,
        string cancelText,
        Color accent)
    {
        using var form = CreateShell(title, 1, new Size(1280, 800));
        var body = BodyPanel();
        var kicker = new Label
        {
            Text = "ONCE / SETUP",
            AutoSize = true,
            ForeColor = accent,
            Font = OnceTheme.Body(9F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 12),
        };
        body.Controls.Add(kicker);
        body.Controls.Add(OnceTheme.Heading(heading));
        body.Controls.Add(OnceTheme.Paragraph(message));

        var accepted = false;
        var buttons = ButtonRow();
        var cancel = OnceTheme.SecondaryButton(cancelText, 160);
        using var measureFont = OnceTheme.Body(10.5F, FontStyle.Bold);
        var accept = OnceTheme.PrimaryButton(acceptText, Math.Max(200, TextRenderer.MeasureText(acceptText, measureFont).Width + 48));
        cancel.Click += (_, _) => form.Close();
        accept.Click += (_, _) => { accepted = true; form.DialogResult = DialogResult.OK; form.Close(); };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(accept);
        body.Controls.Add(buttons);

        form.Controls.Add(body);
        form.Controls.Add(OnceTheme.CreateTopBar());
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            body.PerformLayout();
        };
        form.ShowDialog();
        return accepted;
    }

    private static void ShowNotice(string title, string heading, string message, Color accent, string buttonText)
    {
        using var form = CreateShell(title, 1, new Size(1280, 800));
        var body = BodyPanel();
        var kicker = new Label
        {
            Text = "ONCE / SETUP",
            AutoSize = true,
            ForeColor = accent,
            Font = OnceTheme.Body(9F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 12),
        };
        body.Controls.Add(kicker);
        body.Controls.Add(OnceTheme.Heading(heading));
        body.Controls.Add(OnceTheme.Paragraph(message));

        var buttons = ButtonRow();
        var close = OnceTheme.PrimaryButton(buttonText, 160);
        close.Click += (_, _) => form.Close();
        buttons.Controls.Add(close);
        body.Controls.Add(buttons);

        form.Controls.Add(body);
        form.Controls.Add(OnceTheme.CreateTopBar());
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            body.PerformLayout();
        };
        form.ShowDialog();
    }

    private static Form CreateShell(string title, int step, Size size)
    {
        var form = new Form();
        OnceTheme.Apply(form, title, size);
        form.AutoScroll = false;
        return form;
    }

    private static FlowLayoutPanel BodyPanel()
    {
        var body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            Padding = new Padding(70, 34, 70, 40),
            BackColor = OnceTheme.Background,
        };

        void ResizeFullWidthControls()
        {
            var width = OnceTheme.ContentWidth(body);
            foreach (Control control in body.Controls)
            {
                if (Equals(control.Tag, FullWidthTag))
                {
                    control.Width = width;
                }

                if (control is Label label && label.MaximumSize.Width > 0)
                {
                    label.MaximumSize = new Size(Math.Min(width, OnceTheme.MaxContentWidth), 0);
                }
            }
        }

        body.ControlAdded += (_, e) =>
        {
            if (Equals(e.Control.Tag, FullWidthTag))
            {
                e.Control.Width = OnceTheme.ContentWidth(body);
            }
        };
        body.SizeChanged += (_, _) => ResizeFullWidthControls();
        return body;
    }

    private static FlowLayoutPanel ButtonRow()
    {
        return new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(0, 18, 0, 0),
        };
    }

    private static Button ChoiceCard(string title, string description, bool recommended)
    {
        var button = new Button
        {
            Tag = FullWidthTag,
            Text = recommended
                ? title + "   —   RECOMMENDED\r\n" + description
                : title + "\r\n" + description,
            TextAlign = ContentAlignment.MiddleLeft,
            Width = OnceTheme.MaxContentWidth,
            Height = 120,
            FlatStyle = FlatStyle.Flat,
            BackColor = recommended ? Color.FromArgb(9, 34, 36) : OnceTheme.Surface,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Body(11F, FontStyle.Bold),
            Padding = new Padding(22, 12, 22, 12),
            Cursor = Cursors.Hand,
            Margin = new Padding(0, 0, 0, 16),
        };
        button.FlatAppearance.BorderColor = recommended ? OnceTheme.Accent : OnceTheme.Border;
        button.FlatAppearance.BorderSize = recommended ? 2 : 1;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(12, 43, 45);
        return button;
    }

    private static Panel InfoCard(string title, string content)
    {
        var panel = new Panel
        {
            Tag = FullWidthTag,
            Width = OnceTheme.MaxContentWidth,
            Height = Math.Max(118, 72 + content.Split('\n').Length * 30),
            BackColor = OnceTheme.Surface,
            Margin = new Padding(0, 0, 0, 16),
            Padding = new Padding(22),
        };
        var titleLabel = new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.5F, FontStyle.Bold),
            Location = new Point(22, 18),
        };
        var contentLabel = new Label
        {
            Text = content,
            AutoSize = true,
            MaximumSize = new Size(OnceTheme.MaxContentWidth - 44, 0),
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Body(10.5F),
            Location = new Point(22, 50),
        };
        panel.Controls.Add(titleLabel);
        panel.Controls.Add(contentLabel);
        panel.SizeChanged += (_, _) =>
        {
            contentLabel.MaximumSize = new Size(Math.Max(240, panel.ClientSize.Width - 44), 0);
        };
        return panel;
    }
}
