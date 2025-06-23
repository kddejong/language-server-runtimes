/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import sinon from 'ts-sinon'
import assert from 'assert'
import { TextDocuments } from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { DidSaveTextDocumentParams } from 'vscode-languageserver-protocol'
import { observe } from './textDocumentConnection'

/**
 * This test demonstrates the issue with documents.listen overwriting connection handlers.
 * 
 * The problem:
 * 1. When a handler is registered with connection.onDidSaveTextDocument, it works as expected
 * 2. But when documents.listen(documentsObserver.callbacks) is called, it overwrites the connection handler
 * 3. This causes the original handler to no longer be called when a notification is sent through the connection
 * 
 * This is problematic because:
 * - In standalone.ts and base-runtime.ts, onDidSaveTextDocument is registered with lspServer.setDidSaveTextDocumentHandler
 * - But other document handlers (open, change, close) are registered with documentsObserver.callbacks
 * - When documents.listen is called, it overwrites the connection handler for didSaveTextDocument
 * - This causes the handler registered with lspServer to not be called
 */
describe('documents.listen issue with overwriting connection handlers', () => {
    // Common setup for all tests
    let connection: any
    let saveParams: DidSaveTextDocumentParams
    let documents: TextDocuments<TextDocument>
    let documentsObserver: any
    
    beforeEach(() => {
        // Create a mock connection
        connection = {
            onDidOpenTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidChangeTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidCloseTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidSaveTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onWillSaveTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onWillSaveTextDocumentWaitUntil: sinon.stub().returns({ dispose: sinon.stub() }),
            sendNotification: sinon.stub()
        }
        
        // Setup connection to store handlers
        connection.onDidSaveTextDocument.callsFake((handler) => {
            connection.onDidSaveTextDocument.handler = handler
            return { dispose: sinon.stub() }
        })
        
        // Create standard save params for all tests
        saveParams = {
            textDocument: {
                uri: 'file:///test.txt',
                version: 1,
                languageId: 'plaintext',
            },
            text: 'test content'
        }
        
        // Create TextDocuments and observer
        documents = new TextDocuments(TextDocument)
        documentsObserver = observe(connection)
    })
    
    /**
     * This test demonstrates the basic issue: documents.listen overwrites connection handlers
     */
    it('demonstrates how documents.listen overwrites connection handlers', () => {
        // Create a spy for the original handler
        const originalHandlerSpy = sinon.spy()
        
        // Register our handler with the connection
        connection.onDidSaveTextDocument(originalHandlerSpy)
        
        // STEP 1: Verify handler works before documents.listen
        connection.onDidSaveTextDocument.handler(saveParams)
        assert(originalHandlerSpy.calledOnce, 'Original handler should be called before documents.listen')
        originalHandlerSpy.resetHistory()
        
        // STEP 2: Call documents.listen, which will overwrite the connection handler
        documents.listen(documentsObserver.callbacks)
        
        // Verify that the connection handler was overwritten
        assert(connection.onDidSaveTextDocument.calledTwice, 
            'connection.onDidSaveTextDocument should be called again by documents.listen')
        
        // STEP 3: Send notification through connection after documents.listen
        // Get the new handler that was registered by documents.listen
        const newHandler = connection.onDidSaveTextDocument.args[1][0]
        newHandler(saveParams)
        
        // Verify that our original handler is no longer called
        assert(!originalHandlerSpy.called, 'Original handler should not be called after documents.listen')
    })
    
    /**
     * This test demonstrates how the issue affects the LspServer handler pattern used in the runtime
     */
    it('demonstrates how this affects the LspServer handler pattern', () => {
        // Create a spy for the LspServer handler
        const lspServerHandlerSpy = sinon.spy()
        
        // Register our handler with the connection (simulating what LspServer would do)
        connection.onDidSaveTextDocument(lspServerHandlerSpy)
        
        // STEP 1: Verify handler works before documents.listen
        connection.onDidSaveTextDocument.handler(saveParams)
        assert(lspServerHandlerSpy.calledOnce, 'Handler should be called before documents.listen')
        lspServerHandlerSpy.resetHistory()
        
        // STEP 2: Call documents.listen, which will overwrite the connection handler
        documents.listen(documentsObserver.callbacks)
        
        // STEP 3: Send notification through connection after documents.listen
        // Get the new handler that was registered by documents.listen
        const newHandler = connection.onDidSaveTextDocument.args[1][0]
        newHandler(saveParams)
        
        // Verify that our original handler is no longer called
        assert(!lspServerHandlerSpy.called, 'Handler should not be called after documents.listen')
        
        // This demonstrates the issue in the runtime:
        // 1. In standalone.ts and base-runtime.ts, onDidSaveTextDocument is registered with lspServer.setDidSaveTextDocumentHandler
        // 2. But when documents.listen is called, it overwrites the connection handler
        // 3. This causes the handler registered with lspServer to not be called when a notification is sent through the connection
    })
    
    /**
     * This test demonstrates how the issue affects the actual runtime implementation
     */
    it('demonstrates how this affects the actual runtime implementation', () => {
        // Create a mock LspServer (simplified version of what's in the runtime)
        const lspServer = {
            setDidSaveTextDocumentHandler: function(handler) {
                this.didSaveTextDocumentHandler = handler
            },
            didSaveTextDocumentHandler: null,
            sendDidSaveTextDocumentNotification: function(params) {
                if (this.didSaveTextDocumentHandler) {
                    this.didSaveTextDocumentHandler(params)
                }
            }
        }
        
        // Create a spy for the handler
        const handlerSpy = sinon.spy()
        
        // This simulates how handlers are registered in standalone.ts and base-runtime.ts
        const lsp = {
            // These handlers use documentsObserver.callbacks (works with documents.listen)
            onDidOpenTextDocument: handler => documentsObserver.callbacks.onDidOpenTextDocument(handler),
            onDidChangeTextDocument: handler => documentsObserver.callbacks.onDidChangeTextDocument(handler),
            onDidCloseTextDocument: handler => documentsObserver.callbacks.onDidCloseTextDocument(handler),
            
            // This handler uses lspServer.setDidSaveTextDocumentHandler (doesn't work with documents.listen)
            onDidSaveTextDocument: handler => lspServer.setDidSaveTextDocumentHandler(handler)
        }
        
        // Register our handler using the lsp interface
        lsp.onDidSaveTextDocument(handlerSpy)
        
        // STEP 1: Call documents.listen, which will overwrite the connection handler
        documents.listen(documentsObserver.callbacks)
        
        // STEP 2: Send notification through connection
        // Get the handler that was registered by documents.listen
        const connectionHandler = connection.onDidSaveTextDocument.args[0][0]
        connectionHandler(saveParams)
        
        // Verify that the handler registered with lspServer is not called
        assert(!handlerSpy.called, 'Handler should not be called when notification is sent through connection')
        
        // STEP 3: But if we call the LspServer's method directly, it works
        lspServer.sendDidSaveTextDocumentNotification(saveParams)
        
        // Verify that the handler is called
        assert(handlerSpy.calledOnce, 'Handler should be called when manually invoking sendDidSaveTextDocumentNotification')
    })
})
