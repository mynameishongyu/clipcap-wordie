'use client';

import { useEffect, useState } from 'react';

const JSON_PREVIEW_DEBUG_STORAGE_KEY = 'clipcap-json-preview-debug';
const JSON_PREVIEW_DEBUG_EVENT = 'clipcap-json-preview-debug-change';

interface JsonPreviewDebugController {
  show: () => void;
  hide: () => void;
  toggle: () => void;
  enabled: () => boolean;
}

declare global {
  interface Window {
    clipcapJsonPreview?: JsonPreviewDebugController;
  }
}

function readEnabledState() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(JSON_PREVIEW_DEBUG_STORAGE_KEY) === 'true';
}

function writeEnabledState(nextValue: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(JSON_PREVIEW_DEBUG_STORAGE_KEY, nextValue ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent(JSON_PREVIEW_DEBUG_EVENT));
}

function ensureJsonPreviewController() {
  if (typeof window === 'undefined') {
    return;
  }

  if (window.clipcapJsonPreview) {
    return;
  }

  window.clipcapJsonPreview = {
    show: () => writeEnabledState(true),
    hide: () => writeEnabledState(false),
    toggle: () => writeEnabledState(!readEnabledState()),
    enabled: () => readEnabledState(),
  };
}

export function useJsonPreviewDebug() {
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    ensureJsonPreviewController();
    setIsEnabled(readEnabledState());

    const handleChange = () => {
      setIsEnabled(readEnabledState());
    };

    window.addEventListener(JSON_PREVIEW_DEBUG_EVENT, handleChange);
    window.addEventListener('storage', handleChange);

    return () => {
      window.removeEventListener(JSON_PREVIEW_DEBUG_EVENT, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  return isEnabled;
}
