import { mount, unmount } from './client/core.js';

const Sourcepeek = {
  name: 'Sourcepeek',
  mounted() {
    mount();
  },
  unmounted() {
    unmount();
  },
  render() {
    return null;
  },
};

export default Sourcepeek;
export { Sourcepeek, mount, unmount };
