export type AccessClientInfo = {
  platform: "ios" | "android" | "other";
  deviceLabel: string;
  osVersion: string | null;
};

function clean(value: string) {
  return value.replace(/[_\s]+/g, " ").trim().slice(0, 80);
}

export function accessClientInfo(userAgent: string | undefined): AccessClientInfo {
  const ua = userAgent ?? "";
  const iosDevice = /\b(iPhone|iPad|iPod)\b/.exec(ua)?.[1];
  if (iosDevice) {
    const version = /(?:CPU (?:iPhone )?OS|iPhone OS) ([0-9_]+)/.exec(ua)?.[1];
    return {
      platform: "ios",
      deviceLabel: iosDevice,
      osVersion: version ? version.replaceAll("_", ".") : null,
    };
  }

  const androidVersion = /\bAndroid\s+([0-9.]+)/.exec(ua)?.[1];
  if (androidVersion) {
    const rawDevice = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(
      ua,
    )?.[1];
    return {
      platform: "android",
      deviceLabel: rawDevice ? clean(rawDevice) : "Android device",
      osVersion: androidVersion,
    };
  }

  return {
    platform: "other",
    deviceLabel: /\bMobile\b/i.test(ua) ? "Mobile device" : "Browser",
    osVersion: null,
  };
}
