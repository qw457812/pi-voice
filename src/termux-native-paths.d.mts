export type NativeInstallation = {
  version: string;
  bindingEntry: string;
  directory: string;
  library: string;
};

export function nativeInstallation(options?: {
  bindingEntry?: string;
  cacheRoot?: string;
  platform?: string;
  arch?: string;
}): NativeInstallation;
