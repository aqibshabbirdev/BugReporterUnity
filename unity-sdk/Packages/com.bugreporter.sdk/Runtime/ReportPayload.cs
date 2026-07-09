using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace BugReporter
{
    /// <summary>Everything a single report carries. Serialized by hand — Unity's JsonUtility can't do dictionaries.</summary>
    internal sealed class ReportPayload
    {
        public string title;
        public string description;
        public string severity;
        public string buildVersion;
        public string logs;
        public Dictionary<string, object> metadata;
        public DeviceInfo device;

        /// <summary>The JSON part of the multipart upload. The screenshot and logs travel as separate parts.</summary>
        public string ToJson()
        {
            var sb = new StringBuilder(512);
            sb.Append('{');
            Field(sb, "title", title); sb.Append(',');
            Field(sb, "description", description); sb.Append(',');
            Field(sb, "severity", severity); sb.Append(',');
            Field(sb, "buildVersion", buildVersion); sb.Append(',');
            Field(sb, "platform", device.platform); sb.Append(',');
            Field(sb, "deviceModel", device.deviceModel); sb.Append(',');
            Field(sb, "osVersion", device.osVersion); sb.Append(',');
            Field(sb, "screenResolution", device.screenResolution); sb.Append(',');
            sb.Append("\"memoryMB\":").Append(device.memoryMB).Append(',');
            sb.Append("\"metadata\":").Append(MetadataJson());
            sb.Append('}');
            return sb.ToString();
        }

        private string MetadataJson()
        {
            if (metadata == null || metadata.Count == 0) return "{}";
            var sb = new StringBuilder(128);
            sb.Append('{');
            bool first = true;
            foreach (var kv in metadata)
            {
                if (!first) sb.Append(',');
                first = false;
                Escape(sb, kv.Key);
                sb.Append(':');
                AppendValue(sb, kv.Value);
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendValue(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                // Invariant culture: a locale with ',' as the decimal separator would emit invalid JSON.
                case float f: sb.Append(f.ToString("R", System.Globalization.CultureInfo.InvariantCulture)); break;
                case double d: sb.Append(d.ToString("R", System.Globalization.CultureInfo.InvariantCulture)); break;
                case int i: sb.Append(i.ToString(System.Globalization.CultureInfo.InvariantCulture)); break;
                case long l: sb.Append(l.ToString(System.Globalization.CultureInfo.InvariantCulture)); break;
                default: Escape(sb, v.ToString()); break;
            }
        }

        private static void Field(StringBuilder sb, string key, string value)
        {
            Escape(sb, key);
            sb.Append(':');
            Escape(sb, value ?? string.Empty);
        }

        private static void Escape(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"':  sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n");  break;
                    case '\r': sb.Append("\\r");  break;
                    case '\t': sb.Append("\\t");  break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }

    [Serializable]
    internal struct DeviceInfo
    {
        public string platform;
        public string deviceModel;
        public string osVersion;
        public string screenResolution;
        public int memoryMB;

        public static DeviceInfo Capture() => new DeviceInfo
        {
            platform         = Application.platform.ToString(),
            deviceModel      = SystemInfo.deviceModel,
            osVersion        = SystemInfo.operatingSystem,
            screenResolution = $"{Screen.width}x{Screen.height}",
            memoryMB         = SystemInfo.systemMemorySize,
        };
    }
}
