import { proto } from '../../WAProto/index.js';
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
export declare const botMetadataSignature: () => any;
export declare const botMetadataCertificate: (length?: number) => any;
export declare const wrapToBotForwardedMessage: (richResponseMessage: any) => {
    messageContextInfo: {
        deviceListMetadata: {};
        deviceListMetadataVersion: number;
        botMetadata: {
            verificationMetadata: {
                proofs: {
                    certificateChain: any[];
                    version: number;
                    useCase: number;
                    signature: any;
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
export declare const prepareAiTextMessage: (text: string, options?: {
    disclaimerText?: string;
    title?: string;
    contextInfo?: proto.IContextInfo;
}) => any;
export declare const prepareRichResponseMessage: (content: any) => any;
//# sourceMappingURL=rich-message-utils.d.ts.map