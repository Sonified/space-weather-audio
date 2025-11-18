/**
 * modal-manager.js
 * Centralized modal state management with smooth transitions
 */

class ModalManager {
    constructor() {
        this.currentModal = null;
        this.overlay = document.getElementById('permanentOverlay');
        this.isTransitioning = false;
        this.queue = [];
        
        // Transition timing constants
        this.FADE_DURATION = 300; // Match CSS transition
        this.MODAL_SWAP_DELAY = 100; // Brief pause between modals
    }
    
    /**
     * Open a modal with proper overlay management
     * Handles sequential modals gracefully
     */
    async openModal(modalId, options = {}) {
        const { 
            keepOverlay = false,  // If true, don't fade overlay between modals
            onOpen = null,
            onClose = null 
        } = options;
        
        // Wait if currently transitioning
        while (this.isTransitioning) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        this.isTransitioning = true;
        
        try {
            const modal = document.getElementById(modalId);
            if (!modal) {
                console.error(`❌ Modal not found: ${modalId}`);
                return null;
            }
            
            // If switching modals and keeping overlay visible
            console.log(`🔧 openModal: Checking if swap needed. currentModal=${this.currentModal}, keepOverlay=${keepOverlay}`);
            if (this.currentModal && keepOverlay) {
                console.log(`🔧 openModal: SWAPPING modal (currentModal=${this.currentModal} -> ${modalId})`);
                // Return the promise from swapModal so workflow waits for modal to close
                return await this.swapModal(modalId, { onOpen, onClose });
            } else {
                console.log(`🔧 openModal: FRESH OPEN (currentModal=${this.currentModal}, keepOverlay=${keepOverlay})`);
                // Fresh open (with overlay fade-in)
                await this.closeAllModals();
                await this.fadeInOverlay();
                modal.style.display = 'flex';
                this.currentModal = modalId;
                
                if (onOpen) onOpen();

                // Return promise that resolves when modal closes
                console.log(`🔧 openModal: Creating promise for ${modalId}`);
                console.log(`🔧 openModal: Modal element:`, modal);
                console.log(`🔧 openModal: Current modal state:`, this.currentModal);
                return new Promise((resolve) => {
                    console.log(`🔧 openModal: Setting _closeResolver for ${modalId}`);
                    modal._closeResolver = resolve;
                    modal._onClose = onClose;
                    console.log(`🔧 openModal: Resolver set! modal._closeResolver exists:`, !!modal._closeResolver);
                });
            }
            
        } finally {
            this.isTransitioning = false;
        }
    }
    
    /**
     * Close current modal
     */
    async closeModal(modalId = null, options = {}) {
        const { 
            keepOverlay = false  // If true, keep overlay for next modal
        } = options;
        
        const targetModal = modalId || this.currentModal;
        if (!targetModal) return;
        
        while (this.isTransitioning) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        this.isTransitioning = true;
        
        try {
            const modal = document.getElementById(targetModal);
            if (!modal) {
                console.error(`❌ closeModal: Modal element not found for ${targetModal}`);
                return;
            }
            
            console.log(`🔧 closeModal: Modal element found:`, modal);
            console.log(`🔧 closeModal: Current modal state:`, this.currentModal);
            console.log(`🔧 closeModal: Modal ID attribute:`, modal.id);
            console.log(`🔧 closeModal: Checking _closeResolver for ${targetModal}:`, !!modal._closeResolver);
            console.log(`🔧 closeModal: Modal keys:`, Object.keys(modal).filter(k => k.startsWith('_')));
            
            // Call onClose callback if exists
            if (modal._onClose) {
                modal._onClose();
            }
            
            // Resolve the waiting promise
            if (modal._closeResolver) {
                console.log(`✅ closeModal: Resolving promise for ${targetModal}`);
                modal._closeResolver(true);
                modal._closeResolver = null;
            } else {
                console.warn(`⚠️ closeModal: No _closeResolver found for ${targetModal} - promise won't resolve!`);
                console.warn(`⚠️ closeModal: This means the workflow promise won't resolve and will continue immediately`);
            }
            
            // Hide modal
            modal.style.display = 'none';
            
            // Fade out overlay unless keeping it for next modal
            if (!keepOverlay) {
                await this.fadeOutOverlay();
            }
            
            this.currentModal = keepOverlay ? targetModal : null;
            
        } finally {
            this.isTransitioning = false;
        }
    }
    
    /**
     * Swap one modal for another (no overlay fade)
     * Beautiful pattern for sequential workflows
     * Returns a promise that resolves when the new modal closes
     */
    async swapModal(newModalId, options = {}) {
        const { onOpen = null, onClose = null } = options;
        
        if (!this.currentModal) {
            throw new Error('No modal to swap from');
        }
        
        const oldModal = document.getElementById(this.currentModal);
        const newModal = document.getElementById(newModalId);
        
        if (!newModal) {
            console.error(`❌ New modal not found: ${newModalId}`);
            return null;
        }
        
        // Quick fade between modals
        if (oldModal) {
            oldModal.style.opacity = '1';
            oldModal.style.transition = 'opacity 0.15s ease-out';
            oldModal.style.opacity = '0';
            
            await new Promise(resolve => setTimeout(resolve, 150));
            
            oldModal.style.display = 'none';
            oldModal.style.opacity = '1';
            oldModal.style.transition = '';
        }
        
        // Brief pause for visual clarity
        await new Promise(resolve => setTimeout(resolve, this.MODAL_SWAP_DELAY));
        
        // Fade in new modal
        newModal.style.opacity = '0';
        newModal.style.display = 'flex';
        newModal.style.transition = 'opacity 0.15s ease-in';
        
        // Force reflow
        void newModal.offsetHeight;
        
        newModal.style.opacity = '1';
        
        await new Promise(resolve => setTimeout(resolve, 150));
        
        newModal.style.transition = '';
        this.currentModal = newModalId;
        
        if (onOpen) onOpen();
        
        // Return promise that resolves when modal closes
        return new Promise((resolve) => {
            newModal._closeResolver = resolve;
            newModal._onClose = onClose;
        });
    }
    
    /**
     * Fade in overlay background
     */
    async fadeInOverlay() {
        if (!this.overlay) return;
        
        this.overlay.style.opacity = '0';
        this.overlay.style.display = 'flex';
        
        void this.overlay.offsetHeight; // Force reflow
        
        this.overlay.style.transition = 'opacity 0.3s ease-in';
        this.overlay.style.opacity = '1';
        
        await new Promise(resolve => setTimeout(resolve, this.FADE_DURATION));
    }
    
    /**
     * Fade out overlay background
     */
    async fadeOutOverlay() {
        if (!this.overlay) return;
        
        this.overlay.style.transition = 'opacity 0.3s ease-out';
        this.overlay.style.opacity = '0';
        
        await new Promise(resolve => setTimeout(resolve, this.FADE_DURATION));
        
        if (this.overlay.style.opacity === '0') {
            this.overlay.style.display = 'none';
        }
    }
    
    /**
     * Close all modals at once
     */
    async closeAllModals() {
        const allModalIds = [
            'welcomeModal',
            'participantModal',
            'preSurveyModal',
            'postSurveyModal',
            'activityLevelModal',
            'awesfModal',
            'endModal',
            'beginAnalysisModal',
            'missingStudyIdModal',
            'completeConfirmationModal'
        ];
        
        allModalIds.forEach(modalId => {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.style.display = 'none';
            }
        });
        
        this.currentModal = null;
    }
}

// Create singleton instance
export const modalManager = new ModalManager();

