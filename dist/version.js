export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_PACKAGE = "@yukiykchen/dsh-scan-remote";
export const PLUGIN_REPOSITORY = "yukiykchen/dsh-scan-remote";
export const EXPECTED_DSH_VERSION = "0.1.0-rc.6";
export function compareVersions(left, right) {
    const parse = (value) => value.split(".").map((part) => Number(part));
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference)
            return difference;
    }
    return 0;
}
