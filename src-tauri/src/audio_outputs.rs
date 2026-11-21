use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct AudioOutput {
    id: String,
    label: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputs {
    outputs: Vec<AudioOutput>,
    active_ids: Vec<String>,
    route_known: bool,
}

#[cfg(windows)]
#[tauri::command]
pub async fn get_audio_outputs() -> Result<AudioOutputs, String> {
    tauri::async_runtime::spawn_blocking(windows_outputs)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn enumerated_outputs_have_names_and_distinct_ids() {
        let outputs = super::windows_outputs().unwrap();
        let mut ids = std::collections::HashSet::new();
        for output in &outputs.outputs {
            assert!(!output.id.is_empty());
            assert!(!output.label.is_empty());
            assert!(ids.insert(&output.id));
        }
        assert!(outputs.active_ids.iter().all(|id| ids.contains(id)));
    }
}

#[cfg(windows)]
fn windows_outputs() -> Result<AudioOutputs, String> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia,
        eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize, STGM_READ,
    };

    unsafe fn device_id(device: &IMMDevice) -> windows::core::Result<String> {
        let raw = unsafe { device.GetId()? };
        let id = unsafe { raw.to_string() };
        unsafe { CoTaskMemFree(Some(raw.0.cast())) };
        Ok(id?)
    }

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result = (|| -> windows::core::Result<AudioOutputs> {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .and_then(|device| device_id(&device))
                .ok();
            let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            let mut outputs = Vec::new();
            for index in 0..devices.GetCount()? {
                let device = devices.Item(index)?;
                let id = device_id(&device)?;
                let label = device
                    .OpenPropertyStore(STGM_READ)
                    .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                    .map(|name| name.to_string())
                    .unwrap_or_else(|_| "Audio output".to_string());
                outputs.push(AudioOutput { id, label });
            }
            let route_known = default_id.is_some();
            Ok(AudioOutputs {
                outputs,
                active_ids: default_id.into_iter().collect(),
                route_known,
            })
        })();
        if initialized {
            CoUninitialize();
        }
        result.map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn get_audio_outputs(
    session: tauri::State<'_, crate::media_session::Session>,
) -> Result<AudioOutputs, String> {
    let session = session.inner().clone();
    tauri::async_runtime::spawn_blocking(move || session.audio_outputs())
        .await
        .map_err(|error| error.to_string())?
}
