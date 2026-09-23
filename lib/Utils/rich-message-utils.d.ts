import { CodeHighlightType } from '../Types/RichType.js';
export declare const tokenizeCode: (code: string, language?: string) => {
    highlightType: CodeHighlightType;
    codeContent: string;
}[];
export declare const toUnified: (submessages: any[], uuid?: string) => {
    __typename: string;
    response_id: string;
    sections: any[];
};
export declare const botMetadataSignature: () => Uint8Array<ArrayBuffer>;
export declare const botMetadataCertificate: (length?: number) => Uint8Array<ArrayBuffer>;
export declare const wrapToBotForwardedMessage: (richResponseMessage: any) => {
    messageContextInfo: {
        botMetadata: {
            verificationMetadata: {
                proofs: {
                    certificateChain: Uint8Array<ArrayBuffer>[];
                    version: number;
                    useCase: number;
                    signature: Uint8Array<ArrayBuffer>;
                }[];
            };
        };
    };
    botForwardedMessage: {
        message: {
            richResponseMessage: any;
        };
    };
};
export declare const prepareRichResponseMessage: (content: any) => any;
//# sourceMappingURL=rich-message-utils.d.ts.map