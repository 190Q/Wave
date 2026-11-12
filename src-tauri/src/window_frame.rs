//! Fills the frame Windows leaves around a maximized borderless window.
//!
//! A maximized window is handed its monitor's work area one pixel short on
//! every edge that tao believes carries an auto-hidden taskbar, so the taskbar
//! can still be reached with the mouse. That check answers yes for every edge
//! on Windows 11, which leaves the desktop showing along the left, right and
//! bottom of the window, and a strip of non-client area along the top where the
//! title bar buttons ignore the mouse on the first row of pixels. The work area
//! is taken whole instead, so the webview reaches all four edges.

#[cfg(windows)]
pub fn fill_maximized_window(window: &tauri::WebviewWindow) {
    use std::mem::size_of;

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowPlacement, NCCALCSIZE_PARAMS, SW_MAXIMIZE, WINDOWPLACEMENT, WM_NCCALCSIZE,
    };

    /// Kept apart from the ids tao and tauri give their own subclasses.
    const ID: usize = 0x5741_5645;

    /// The monitor's work area, but only while the window is maximized.
    fn maximized_work_area(hwnd: HWND) -> Option<RECT> {
        let mut placement = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            ..WINDOWPLACEMENT::default()
        };
        unsafe { GetWindowPlacement(hwnd, &mut placement) }.ok()?;
        if placement.showCmd != SW_MAXIMIZE.0 as u32 {
            return None;
        }

        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..MONITORINFO::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return None;
        }
        Some(info.rcWork)
    }

    unsafe extern "system" fn fill(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_NCCALCSIZE && wparam.0 != 0 {
            if let Some(area) = maximized_work_area(hwnd) {
                let params = unsafe { &mut *(lparam.0 as *mut NCCALCSIZE_PARAMS) };
                params.rgrc[0] = area;
                return LRESULT(0);
            }
        }

        // Everything else, including the frame a restored window keeps for its
        // shadow and resize edges, belongs to tao.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(fill), ID, 0);
    }
}
