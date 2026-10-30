<script>
  import { onMount } from 'svelte';
  import { mount, unmount } from '../client/core.js';

  onMount(() => {
    mount();
    return unmount;
  });
</script>
