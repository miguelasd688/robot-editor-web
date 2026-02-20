import { useCallback, useRef } from "react";

export function useWorkspaceImport(importFiles: (files: FileList) => void) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImportChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      importFiles(files);
      e.target.value = "";
    },
    [importFiles]
  );

  return { fileInputRef, onImportClick, onImportChange };
}
