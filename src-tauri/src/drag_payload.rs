//! Hand-built `IDataObject` for the native drag-out.
//!
//! `SHCreateDataObject` returns a shell object whose `GetData` may marshal into
//! another apartment (shell/desktop). During a drag the shell can be busy, so a
//! marshalled call blocks the modal OLE loop before it processes the next pointer
//! message. This object owns the payload: `CF_HDROP` is a plain `DROPFILES` blob
//! allocated with `GlobalAlloc`, so every format negotiation stays in-process.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use windows::core::{implement, BOOL, HRESULT, Result as WinResult};
use windows::Win32::Foundation::{HGLOBAL, POINT};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl, IEnumSTATDATA,
    STGMEDIUM, STGMEDIUM_0, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
};
use windows::Win32::UI::Shell::DROPFILES;

const CF_TEXT: u16 = 1;
const CF_HDROP: u16 = 15;

fn format_etc(format: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

fn preferred_drop_effect_format() -> u16 {
    static ID: OnceLock<u16> = OnceLock::new();
    *ID.get_or_init(|| unsafe {
        let name = windows::core::HSTRING::from("Preferred DropEffect");
        RegisterClipboardFormatW(&name) as u16
    })
}

fn allocate(bytes: usize) -> Option<HGLOBAL> {
    unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes).ok() }
}

fn global_medium(handle: HGLOBAL) -> STGMEDIUM {
    STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    }
}

#[implement(IDataObject)]
pub(crate) struct FilesDataObject {
    files: Vec<String>,
    drop_effect: AtomicU32,
}

impl FilesDataObject {
    fn new(files: Vec<String>, drop_effect: u32) -> Self {
        Self {
            files,
            drop_effect: AtomicU32::new(drop_effect),
        }
    }

    fn hdrop_medium(&self) -> Option<STGMEDIUM> {
        let header = std::mem::size_of::<DROPFILES>();
        let mut wide: Vec<u16> = Vec::new();
        for file in &self.files {
            wide.extend(file.encode_utf16());
            wide.push(0);
        }
        wide.push(0);
        let size = header + wide.len() * std::mem::size_of::<u16>();
        let handle = allocate(size)?;
        unsafe {
            let base = GlobalLock(handle) as *mut u8;
            if base.is_null() {
                return None;
            }
            let drop = base as *mut DROPFILES;
            (*drop).pFiles = header as u32;
            (*drop).pt = POINT { x: 0, y: 0 };
            (*drop).fNC = BOOL(0);
            (*drop).fWide = BOOL(1);
            std::ptr::copy_nonoverlapping(wide.as_ptr(), base.add(header) as *mut u16, wide.len());
            let _ = GlobalUnlock(handle);
        }
        Some(global_medium(handle))
    }

    fn text_medium(&self) -> Option<STGMEDIUM> {
        let joined = self.files.join("\r\n");
        let mut wide: Vec<u16> = joined.encode_utf16().collect();
        wide.push(0);
        let handle = allocate(wide.len() * std::mem::size_of::<u16>())?;
        unsafe {
            let target = GlobalLock(handle) as *mut u16;
            if target.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
            let _ = GlobalUnlock(handle);
        }
        Some(global_medium(handle))
    }

    fn effect_medium(&self) -> Option<STGMEDIUM> {
        let handle = allocate(std::mem::size_of::<u32>())?;
        unsafe {
            let target = GlobalLock(handle) as *mut u32;
            if target.is_null() {
                return None;
            }
            *target = self.drop_effect.load(Ordering::Relaxed);
            let _ = GlobalUnlock(handle);
        }
        Some(global_medium(handle))
    }

    fn formats(&self) -> Vec<u16> {
        let effect = preferred_drop_effect_format();
        let mut formats = vec![CF_HDROP, CF_TEXT];
        if effect != 0 {
            formats.push(effect);
        }
        formats
    }
}

fn internal_error() -> windows::core::Error {
    windows::core::Error::from_hresult(HRESULT(0x8007_000Eu32 as i32))
}

fn not_implemented() -> windows::core::Error {
    windows::core::Error::from_hresult(HRESULT(0x8004_0004u32 as i32))
}

impl IDataObject_Impl for FilesDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        let format = unsafe { *pformatetcin };
        let medium = match format.cfFormat {
            CF_HDROP => self.hdrop_medium(),
            CF_TEXT => self.text_medium(),
            other if other == preferred_drop_effect_format() => self.effect_medium(),
            _ => None,
        };
        medium.ok_or_else(internal_error)
    }

    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> WinResult<()> {
        Err(not_implemented())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        let format = unsafe { *pformatetc };
        if self.formats().contains(&format.cfFormat) {
            HRESULT(0)
        } else {
            HRESULT(0x8004_0064u32 as i32)
        }
    }

    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, _: *mut FORMATETC) -> HRESULT {
        HRESULT(0x0004_0130) // DATA_S_SAMEFORMATETC
    }

    fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> WinResult<()> {
        Err(not_implemented())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        if dwdirection != 1 {
            return Err(not_implemented());
        }
        let enumerator: IEnumFORMATETC = FormatEtcEnumerator {
            formats: self.formats(),
            index: std::sync::Mutex::new(0),
        }
        .into();
        Ok(enumerator)
    }

    fn DAdvise(
        &self,
        _: *const FORMATETC,
        _: u32,
        _: windows::core::Ref<'_, IAdviseSink>,
    ) -> WinResult<u32> {
        Err(not_implemented())
    }

    fn DUnadvise(&self, _: u32) -> WinResult<()> {
        Err(not_implemented())
    }

    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(not_implemented())
    }
}

#[implement(IEnumFORMATETC)]
struct FormatEtcEnumerator {
    formats: Vec<u16>,
    index: std::sync::Mutex<usize>,
}

impl IEnumFORMATETC_Impl for FormatEtcEnumerator_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        let Ok(mut index) = self.index.lock() else {
            return HRESULT(0x8000_4005u32 as i32);
        };
        let mut fetched = 0u32;
        while (fetched as usize) < celt as usize && *index < self.formats.len() {
            let entry = format_etc(self.formats[*index]);
            unsafe {
                rgelt.add(fetched as usize).write(entry);
            }
            fetched += 1;
            *index += 1;
        }
        if !pceltfetched.is_null() {
            unsafe {
                *pceltfetched = fetched;
            }
        }
        if fetched == celt {
            HRESULT(0)
        } else {
            HRESULT(1)
        }
    }

    fn Skip(&self, celt: u32) -> WinResult<()> {
        let mut index = self.index.lock().map_err(|_| internal_error())?;
        *index = (*index + celt as usize).min(self.formats.len());
        Ok(())
    }

    fn Reset(&self) -> WinResult<()> {
        if let Ok(mut index) = self.index.lock() {
            *index = 0;
        }
        Ok(())
    }

    fn Clone(&self) -> WinResult<IEnumFORMATETC> {
        let index = self.index.lock().map(|guard| *guard).unwrap_or_default();
        let clone: IEnumFORMATETC = FormatEtcEnumerator {
            formats: self.formats.clone(),
            index: std::sync::Mutex::new(index),
        }
        .into();
        Ok(clone)
    }
}

/// Builds the drag payload for `files` (absolute paths).
pub(crate) fn build(files: &[String], drop_effect: u32) -> IDataObject {
    FilesDataObject::new(files.to_vec(), drop_effect).into()
}
