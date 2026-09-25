using System.Text.Json.Serialization;

namespace OnceMonitor;

internal sealed class MonitorSnapshot
{
    [JsonPropertyName("schema")]
    public string Schema { get; set; } = string.Empty;

    [JsonPropertyName("generatedAt")]
    public DateTimeOffset GeneratedAt { get; set; }

    [JsonPropertyName("project")]
    public MonitorProject Project { get; set; } = new();

    [JsonPropertyName("environment")]
    public MonitorEnvironment Environment { get; set; } = new();

    [JsonPropertyName("health")]
    public string Health { get; set; } = "NO_TOOLS_OBSERVED";

    [JsonPropertyName("summary")]
    public MonitorSummary Summary { get; set; } = new();

    [JsonPropertyName("tools")]
    public List<MonitorTool> Tools { get; set; } = new();

    [JsonPropertyName("capabilities")]
    public MonitorCapabilities Capabilities { get; set; } = new();

    [JsonPropertyName("privacy")]
    public MonitorPrivacy Privacy { get; set; } = new();
}

internal sealed class MonitorProject
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "project";
}

internal sealed class MonitorEnvironment
{
    [JsonPropertyName("nodeVersion")]
    public string NodeVersion { get; set; } = string.Empty;

    [JsonPropertyName("languages")]
    public List<string> Languages { get; set; } = new();

    [JsonPropertyName("tooling")]
    public List<string> Tooling { get; set; } = new();
}

internal sealed class MonitorSummary
{
    [JsonPropertyName("configuredSources")]
    public int ConfiguredSources { get; set; }

    [JsonPropertyName("toolsDiscovered")]
    public int ToolsDiscovered { get; set; }

    [JsonPropertyName("modelVisible")]
    public int ModelVisible { get; set; }

    [JsonPropertyName("executionEvidence")]
    public int ExecutionEvidence { get; set; }

    [JsonPropertyName("readOnly")]
    public int ReadOnly { get; set; }

    [JsonPropertyName("protected")]
    public int Protected { get; set; }

    [JsonPropertyName("needsAttention")]
    public int NeedsAttention { get; set; }

    [JsonPropertyName("unknown")]
    public int Unknown { get; set; }
}

internal sealed class MonitorTool
{
    [JsonPropertyName("toolId")]
    public string ToolId { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("framework")]
    public string? Framework { get; set; }

    [JsonPropertyName("evidenceLevel")]
    public string EvidenceLevel { get; set; } = string.Empty;

    [JsonPropertyName("effectClass")]
    public string EffectClass { get; set; } = string.Empty;

    [JsonPropertyName("importanceBand")]
    public string ImportanceBand { get; set; } = string.Empty;

    [JsonPropertyName("action")]
    public string Action { get; set; } = string.Empty;

    [JsonPropertyName("protection")]
    public string Protection { get; set; } = string.Empty;

    [JsonPropertyName("visibility")]
    public MonitorVisibility Visibility { get; set; } = new();
}

internal sealed class MonitorVisibility
{
    [JsonPropertyName("configured")]
    public bool Configured { get; set; }

    [JsonPropertyName("runtimeRegistered")]
    public bool RuntimeRegistered { get; set; }

    [JsonPropertyName("modelVisible")]
    public bool ModelVisible { get; set; }

    [JsonPropertyName("executed")]
    public bool Executed { get; set; }
}

internal sealed class MonitorCapabilities
{
    [JsonPropertyName("chronologicalActivityFeed")]
    public bool ChronologicalActivityFeed { get; set; }
}

internal sealed class MonitorPrivacy
{
    [JsonPropertyName("localReadOnly")]
    public bool LocalReadOnly { get; set; }

    [JsonPropertyName("sourceUploaded")]
    public bool SourceUploaded { get; set; }

    [JsonPropertyName("secretValuesIncluded")]
    public bool SecretValuesIncluded { get; set; }

    [JsonPropertyName("payloadsIncluded")]
    public bool PayloadsIncluded { get; set; }

    [JsonPropertyName("absolutePathsIncluded")]
    public bool AbsolutePathsIncluded { get; set; }
}

internal sealed record MonitorLoadResult(
    MonitorSnapshot? Snapshot,
    string? Error)
{
    public bool IsAvailable => Snapshot is not null && string.IsNullOrWhiteSpace(Error);
}
