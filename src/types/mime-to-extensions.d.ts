declare module "mime-to-extensions" {
    const mime: {
        lookup(path: string): string | false;
        contentType(type: string): string | false;
        extension(type: string): string | false;
        allExtensions(type: string): string[] | false;
        charset(type: string): string | false;
        types: Record<string, string>;
        extensions: Record<string, string[]>;
    };
    export default mime;
}
