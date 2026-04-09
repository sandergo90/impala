import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function useDebouncedSetting(key: string, scope: string) {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setLoaded(false);
    invoke<string | null>("get_setting", { key, scope })
      .then((val) => {
        setValue(val ?? "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [key, scope]);

  const handleChange = (newValue: string) => {
    setValue(newValue);
    if (!loaded) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        if (newValue.trim()) {
          await invoke("set_setting", { key, scope, value: newValue.trim() });
        } else {
          await invoke("delete_setting", { key, scope });
        }
      } catch (e) {
        toast.error(`Failed to save setting: ${e}`);
      }
    }, 500);
  };

  return [value, handleChange, loaded] as const;
}
