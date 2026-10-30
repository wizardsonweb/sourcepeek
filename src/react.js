'use client';
import { useEffect } from 'react';
import { mount, unmount } from './client/core.js';

export default function Sourcepeek() {
  useEffect(() => {
    mount();
    return unmount;
  }, []);
  return null;
}

export { Sourcepeek, mount, unmount };
