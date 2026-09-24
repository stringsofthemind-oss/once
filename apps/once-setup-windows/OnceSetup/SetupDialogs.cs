namespace OnceSetup;

internal enum ProjectMode
{
    Cancel,
    Demo,
    Existing,
}

internal static class SetupDialogs
{
    internal static ProjectMode ChooseProjectMode()
    {
        using var form = CreateShell("Choose a project");
        var viewport = CreateBody(out var content, 1060);

        AddRow(content, OnceTheme.Heading("CHOOSE A PROJECT", 21F), Bottom(12));
        AddRow(content, OnceTheme.Paragraph(
            "Set up Once in a safe demo project or connect an existing Node.js project."), Bottom(24));

        var result = ProjectMode.Cancel;
        var demo = ChoiceCard(
            "Create a safe demo project",
            "Recommended for a first evaluation. Once creates an isolated project and runs the retry-suppression proof.",
            recommended: true);
        demo.Click += (_, _) =>
        {
            result = ProjectMode.Demo;
            form.DialogResult = DialogResult.OK;
            form.Close();
        };
        AddRow(content, demo, Bottom(16));

        var existing = ChoiceCard(
            "Use my existing Node.js project",
            "Choose a folder that already contains package.json. Once will not modify your application source code.",
            recommended: false);
        existing.Click += (_, _) =>
        {
            result = ProjectMode.Existing;
            form.DialogResult = DialogResult.OK;
            form.Close();
        };
        AddRow(content, existing, Bottom(24));

        var buttons = ButtonRow();
        var cancel = OnceTheme.SecondaryButton("Cancel", 190);
        cancel.Click += (_, _) => form.Close();
        buttons.Controls.Add(cancel);
        AddRow(content, buttons);

        ShowPage(form, viewport, 2);
        return result;
    }

    internal static bool ConfirmSetup(string root, bool isDemo)
    {
        using var form = CreateShell("Ready to install");
        var viewport = CreateBody(out var content, 1060);

        AddRow(content, OnceTheme.Heading("READY TO INSTALL ONCE", 21F), Bottom(12));
        AddRow(content, OnceTheme.Paragraph(
            "Once will set up the selected folder using the same guarded path you just evaluated."), Bottom(22));

        AddRow(content, InfoCard("SELECTED FOLDER", root), Bottom(16));

        var actions = isDemo
            ? "✓ Install @once-agent/sdk\n✓ Save the evaluation key to .env\n✓ Add .env to .gitignore\n✓ Verify the Once connection\n✓ Run the safe retry-suppression demo"
            : "✓ Install @once-agent/sdk\n✓ Save the evaluation key to .env\n✓ Add .env to .gitignore\n✓ Verify the Once connection";
        AddRow(content, InfoCard("WHAT ONCE WILL DO", actions), Bottom(18));
        AddRow(content, OnceTheme.Paragraph("Once will not modify your application source code."), Bottom(22));

        var accepted = false;
        var buttons = ButtonRow();
        var cancel = OnceTheme.SecondaryButton("Cancel", 190);
        cancel.Margin = new Padding(0, 0, OnceTheme.S(14), 0);
        cancel.Click += (_, _) => form.Close();

        var install = OnceTheme.PrimaryButton("Install Once  →", 250);
        install.Click += (_, _) =>
        {
            accepted = true;
            form.DialogResult = DialogResult.OK;
            form.Close();
        };

        buttons.Controls.Add(cancel);
        buttons.Controls.Add(install);
        AddRow(content, buttons);

        ShowPage(form, viewport, 3);
        return accepted;
    }

    internal static bool ConfirmKeyReplacement() => ShowDecision(
        "Existing Once key detected",
        "THIS PROJECT ALREADY HAS ONCE",
        "A different ONCE_API_KEY already exists in this project's .env file. Replace it with the evaluation key?",
        "Replace key",
        "Cancel",
        OnceTheme.Warning);

    internal static bool AskOpenNodeDownload() => ShowDecision(
        "Node.js required",
        "NODE.JS 18+ REQUIRED",
        "Once automatic setup needs Node.js 18 or newer, but Node.js was not found on this computer.",
        "Open Node.js download",
        "Cancel",
        OnceTheme.Warning);

    internal static bool AskChooseAnotherProject() => ShowDecision(
        "Choose another project",
        "PACKAGE.JSON NOT FOUND",
        "That folder does not contain package.json, so Once cannot safely identify it as a Node.js project.",
        "Choose another folder",
        "Cancel",
        OnceTheme.Warning);

    internal static void ShowError(string heading, string message) =>
        ShowNotice("Once Setup", heading, message, OnceTheme.Danger, "Try again");

    internal static void ShowWarning(string heading, string message) =>
        ShowNotice("Once Setup", heading, message, OnceTheme.Warning, "OK");

    internal static void ShowCompletion(string root, bool isDemo)
    {
        using var form = CreateShell("Once Setup complete");
        var viewport = CreateBody(out var content, 1060);

        AddRow(content, OnceTheme.Heading("ONCE IS READY", 23F), Bottom(8));
        AddRow(content, OnceTheme.Paragraph(
            isDemo
                ? "Installed, connected, and verified. The retry-suppression proof passed."
                : "Installed, connected, and verified. You're ready to integrate Once into this project."), Bottom(18));

        var statusText = isDemo
            ? "✓ API connection        Connected\n✓ Demo project          Ready\n✓ Duplicate execution   Suppressed\n✓ Side effects          1"
            : "✓ API connection        Connected\n✓ SDK                   Installed\n✓ Environment           Key stored in .env\n✓ Source files          Unchanged";
        AddRow(content, InfoCard("VERIFICATION", statusText), Bottom(14));

        var nextStep = isDemo
            ? "Run the proof again:\nnode .\\once-demo.mjs\n\nPassing result: ONCE_DEMO_PASS"
            : "Integrate the Once SDK around consequential side-effecting operations that may be retried. Setup did not modify your application source.";
        AddRow(content, CompletionInfoPair(
            isDemo ? "DEMO FOLDER" : "PROJECT",
            root,
            "NEXT STEP",
            nextStep), Bottom(16));

        var secondaryActions = ButtonRow();
        var openFolder = OnceTheme.SecondaryButton(isDemo ? "Open demo folder" : "Open project folder", 250);
        openFolder.Margin = new Padding(0, 0, OnceTheme.S(14), 0);
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
                // Completion remains successful if Explorer cannot be opened.
            }
        };
        secondaryActions.Controls.Add(openFolder);

        if (isDemo)
        {
            var saveProof = OnceTheme.SecondaryButton("Save proof report", 245);
            saveProof.Click += (_, _) => SaveProofReport(form, root, saveProof);
            secondaryActions.Controls.Add(saveProof);
        }
        AddRow(content, secondaryActions, Bottom(12));

        var finishRow = new TableLayoutPanel
        {
            Tag = "full",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = OnceTheme.Background,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        finishRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        finishRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var finish = OnceTheme.PrimaryButton("Finish setup  →", 235);
        finish.Margin = Padding.Empty;
        finish.Click += (_, _) => form.Close();
        finishRow.Controls.Add(finish, 1, 0);
        AddRow(content, finishRow);

        ShowPage(form, viewport, 5);
    }

    private static void SaveProofReport(Form owner, string root, Button button)
    {
        try
        {
            var downloads = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Downloads");

            using var dialog = new SaveFileDialog
            {
                Title = "Save Once proof report",
                Filter = "Text report (*.txt)|*.txt|All files (*.*)|*.*",
                DefaultExt = "txt",
                AddExtension = true,
                RestoreDirectory = true,
                FileName = $"Once-Proof-Report-{DateTime.UtcNow:yyyyMMdd-HHmmss}.txt",
                InitialDirectory = Directory.Exists(downloads) ? downloads : root,
            };

            if (dialog.ShowDialog(owner) != DialogResult.OK)
            {
                return;
            }

            File.WriteAllText(dialog.FileName, BuildProofReport(root));
            button.Text = "Report saved ✓";

            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = dialog.FileName,
                    UseShellExecute = true,
                });
            }
            catch
            {
                // The report is still successfully saved if Windows cannot open it automatically.
            }
        }
        catch
        {
            button.Text = "Save failed";
        }
    }

    private static string BuildProofReport(string root)
    {
        return $"""
ONCE EXECUTION SAFETY PROOF REPORT
=================================

Result: PASS
Generated (UTC): {DateTimeOffset.UtcNow:O}
Once Setup version: {OnceTheme.BuildVersion}
Project: {root}

Verification
------------
API connection: Connected
Demo project: Ready
Duplicate execution: Suppressed
Side effects: 1

Re-run command
--------------
node .\once-demo.mjs

Passing token
-------------
ONCE_DEMO_PASS

Security
--------
The Once API key is intentionally omitted from this report.

This report records the successful retry-suppression verification shown by Once Setup.
""";
    }

    private static bool ShowDecision(
        string title,
        string heading,
        string message,
        string acceptText,
        string cancelText,
        Color accent)
    {
        using var form = CreateShell(title);
        var viewport = CreateBody(out var content, 940);

        AddRow(content, Kicker("ONCE / SETUP", accent), Bottom(14));
        AddRow(content, OnceTheme.Heading(heading, 20F), Bottom(12));
        AddRow(content, OnceTheme.Paragraph(message), Bottom(24));

        var accepted = false;
        var buttons = ButtonRow();
        var cancel = OnceTheme.SecondaryButton(cancelText, 190);
        cancel.Margin = new Padding(0, 0, OnceTheme.S(14), 0);
        cancel.Click += (_, _) => form.Close();

        var accept = OnceTheme.PrimaryButton(acceptText, 270);
        accept.Click += (_, _) =>
        {
            accepted = true;
            form.DialogResult = DialogResult.OK;
            form.Close();
        };

        buttons.Controls.Add(cancel);
        buttons.Controls.Add(accept);
        AddRow(content, buttons);

        ShowPage(form, viewport, null);
        return accepted;
    }

    private static void ShowNotice(string title, string heading, string message, Color accent, string buttonText)
    {
        using var form = CreateShell(title);
        var viewport = CreateBody(out var content, 940);

        AddRow(content, Kicker("ONCE / SETUP", accent), Bottom(14));
        AddRow(content, OnceTheme.Heading(heading, 20F), Bottom(12));
        AddRow(content, OnceTheme.Paragraph(message), Bottom(24));

        var buttons = ButtonRow();
        var close = OnceTheme.PrimaryButton(buttonText, 210);
        close.Click += (_, _) => form.Close();
        buttons.Controls.Add(close);
        AddRow(content, buttons);

        ShowPage(form, viewport, null);
    }

    private static Form CreateShell(string title)
    {
        var form = new Form();
        OnceTheme.Apply(form, title, new Size(1360, 860));
        form.AutoScroll = false;
        return form;
    }

    private static Panel CreateBody(out TableLayoutPanel content, int maxWidth)
    {
        var viewport = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = OnceTheme.Background,
            Padding = new Padding(OnceTheme.S(36)),
        };

        content = new TableLayoutPanel
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
        viewport.Controls.Add(content);

        var targetMax = OnceTheme.S(maxWidth);
        var table = content;
        void Reflow()
        {
            if (viewport.ClientSize.Width <= 0)
            {
                return;
            }

            var available = Math.Max(OnceTheme.S(520), viewport.ClientSize.Width - viewport.Padding.Horizontal);
            var width = Math.Min(targetMax, available);
            table.MinimumSize = new Size(width, 0);
            table.MaximumSize = new Size(width, 0);
            table.Left = Math.Max(viewport.Padding.Left, (viewport.ClientSize.Width - width) / 2);
            table.Top = viewport.Padding.Top;

            foreach (Control control in table.Controls)
            {
                if (control is Label label && label.MaximumSize.Width > 0)
                {
                    label.MaximumSize = new Size(width, 0);
                }

                if (control is TableLayoutPanel card && Equals(card.Tag, "full"))
                {
                    card.MinimumSize = new Size(width, 0);
                    card.MaximumSize = new Size(width, 0);
                }

                if (control is Button button && Equals(button.Tag, "full"))
                {
                    button.MinimumSize = new Size(width, OnceTheme.S(126));
                    button.MaximumSize = new Size(width, 0);
                    button.Width = width;
                }
            }
        }

        viewport.SizeChanged += (_, _) => Reflow();
        viewport.HandleCreated += (_, _) => Reflow();
        return viewport;
    }

    private static void ShowPage(Form form, Panel viewport, int? activeStep)
    {
        form.Controls.Add(OnceTheme.CreateChrome(viewport, activeStep));
        form.Shown += (_, _) =>
        {
            OnceTheme.FitToWorkingArea(form);
            viewport.PerformLayout();
            form.ActiveControl = null;
            viewport.AutoScrollPosition = Point.Empty;

            form.BeginInvoke(new Action(() =>
            {
                form.ActiveControl = null;
                viewport.AutoScrollPosition = Point.Empty;
            }));
        };
        form.ShowDialog();
    }

    private static FlowLayoutPanel ButtonRow() => new()
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        FlowDirection = FlowDirection.LeftToRight,
        WrapContents = false,
        Margin = Padding.Empty,
        Padding = Padding.Empty,
    };

    private static Button ChoiceCard(string title, string description, bool recommended)
    {
        var button = new Button
        {
            Tag = "full",
            Text = recommended
                ? title + "   —   RECOMMENDED\r\n\r\n" + description
                : title + "\r\n\r\n" + description,
            TextAlign = ContentAlignment.MiddleLeft,
            AutoSize = false,
            Height = OnceTheme.S(140),
            FlatStyle = FlatStyle.Flat,
            BackColor = recommended ? Color.FromArgb(9, 34, 36) : OnceTheme.Surface,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Body(10.25F, FontStyle.Bold),
            Padding = new Padding(OnceTheme.S(26), OnceTheme.S(18), OnceTheme.S(26), OnceTheme.S(18)),
            Cursor = Cursors.Hand,
            Margin = Padding.Empty,
            UseCompatibleTextRendering = false,
        };
        button.FlatAppearance.BorderColor = recommended ? OnceTheme.Accent : OnceTheme.Border;
        button.FlatAppearance.BorderSize = recommended ? 2 : 1;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(12, 43, 45);
        return button;
    }

    private static TableLayoutPanel CompletionInfoPair(
        string leftTitle,
        string leftContent,
        string rightTitle,
        string rightContent)
    {
        var pair = new TableLayoutPanel
        {
            Tag = "full",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = OnceTheme.Background,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        pair.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));
        pair.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50F));

        var left = InfoCard(leftTitle, leftContent);
        left.Tag = null;
        left.Dock = DockStyle.Fill;
        left.Margin = new Padding(0, 0, OnceTheme.S(8), 0);

        var right = InfoCard(rightTitle, rightContent);
        right.Tag = null;
        right.Dock = DockStyle.Fill;
        right.Margin = new Padding(OnceTheme.S(8), 0, 0, 0);

        pair.Controls.Add(left, 0, 0);
        pair.Controls.Add(right, 1, 0);
        return pair;
    }

    private static TableLayoutPanel InfoCard(string title, string content)
    {
        var card = new TableLayoutPanel
        {
            Tag = "full",
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 0,
            BackColor = OnceTheme.Surface,
            Padding = new Padding(OnceTheme.S(24)),
            Margin = Padding.Empty,
        };
        card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

        AddRow(card, new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = OnceTheme.Accent,
            Font = OnceTheme.Body(9.25F, FontStyle.Bold),
            Margin = Padding.Empty,
            UseCompatibleTextRendering = false,
        }, Bottom(12));

        AddRow(card, new Label
        {
            Text = content,
            AutoSize = true,
            ForeColor = OnceTheme.Text,
            Font = OnceTheme.Body(10F),
            Margin = Padding.Empty,
            MaximumSize = new Size(OnceTheme.MaxContentWidth - OnceTheme.S(48), 0),
            UseCompatibleTextRendering = false,
        });

        return card;
    }

    private static Label Kicker(string text, Color color) => new()
    {
        Text = text,
        AutoSize = true,
        ForeColor = color,
        Font = OnceTheme.Body(9.5F, FontStyle.Bold),
        Margin = Padding.Empty,
        UseCompatibleTextRendering = false,
    };

    private static Padding Bottom(int value) => new(0, 0, 0, OnceTheme.S(value));

    private static void AddRow(TableLayoutPanel table, Control control, Padding? margin = null)
    {
        var row = table.RowCount++;
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        control.Margin = margin ?? control.Margin;
        table.Controls.Add(control, 0, row);
    }
}
