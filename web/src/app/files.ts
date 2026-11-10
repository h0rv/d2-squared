interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface PickerWindow {
  showOpenFilePicker?: (options: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<FileHandle>;
}

const TYPES = [{ description: "D2 diagram", accept: { "text/plain": [".d2"] } }];
const picker = window as unknown as PickerWindow;

export interface OpenedFile {
  name: string;
  text: string;
}

export class LocalFile {
  private handle: FileHandle | null = null;

  get name(): string {
    return this.handle?.name ?? "diagram.d2";
  }

  async open(): Promise<OpenedFile | null> {
    if (picker.showOpenFilePicker) {
      try {
        const [handle] = await picker.showOpenFilePicker({ types: TYPES });
        if (!handle) return null;
        this.handle = handle;
        return { name: handle.name, text: await (await handle.getFile()).text() };
      } catch {
        return null;
      }
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".d2,text/plain";
      input.hidden = true;
      input.onchange = async () => {
        const file = input.files?.[0];
        input.remove();
        resolve(file ? { name: file.name, text: await file.text() } : null);
      };
      input.oncancel = () => {
        input.remove();
        resolve(null);
      };
      document.body.append(input);
      input.click();
    });
  }

  async save(text: string): Promise<string | null> {
    if (picker.showSaveFilePicker) {
      try {
        if (!this.handle) this.handle = await picker.showSaveFilePicker({ suggestedName: "diagram.d2", types: TYPES });
        const writable = await this.handle.createWritable();
        await writable.write(text);
        await writable.close();
        return this.handle.name;
      } catch {
        return null;
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = this.name;
    link.click();
    URL.revokeObjectURL(url);
    return this.name;
  }
}
