/**
 * True when the page is running in WebKitGTK, the only webview Tauri uses on
 * Linux.
 *
 * WebView2 on Windows puts a `Chrome/` token in the user agent and WKWebView
 * says nothing about Linux, so a Linux user agent without a Chrome token is
 * WebKitGTK. A few effects are skipped there because WebKitGTK renders them
 * unreliably rather than because they are unsupported.
 */
export const isWebKitGtk =
  /Linux/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);
