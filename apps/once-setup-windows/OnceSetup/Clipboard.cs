using System.Text.RegularExpressions;

namespace OnceSetup;

internal static class Clipboard
{
    private static readonly Regex EvaluationKeyPattern = new(
        "^once_test_[A-Za-z0-9_-]{32,128}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    internal static string GetText()
    {
        try
        {
            var automatic = System.Windows.Forms.Clipboard.GetText()?.Trim() ?? string.Empty;
            if (EvaluationKeyPattern.IsMatch(automatic))
            {
                return automatic;
            }
        }
        catch
        {
            // Fall through to explicit key entry.
        }

        while (true)
        {
            using var prompt = new ApiKeyPrompt();
            if (prompt.ShowDialog() != DialogResult.OK)
            {
                return string.Empty;
            }

            var candidate = prompt.ApiKey;
            if (EvaluationKeyPattern.IsMatch(candidate))
            {
                return candidate;
            }

            MessageBox.Show(
                "That does not look like a Once evaluation API key.\n\nCopy or paste only the key beginning with once_test_, then try again.",
                "Once Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    internal static void Clear()
    {
        try
        {
            System.Windows.Forms.Clipboard.Clear();
        }
        catch
        {
            // Clearing the clipboard is best-effort after successful setup.
        }
    }
}
