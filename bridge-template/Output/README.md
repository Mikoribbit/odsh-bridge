# Output/ - result exit (SHARED)
Results land here as <taskId>_result.json (written atomically by the daemon).
Both containers may read; name files <timestamp>_<taskId>_<type>.<ext> to avoid collision.
