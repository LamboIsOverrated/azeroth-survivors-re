//! Browser world re-entry closes both protocol sockets before starting another page.
use std::cell::RefCell;
use std::rc::{Rc, Weak};

use super::Socket;

thread_local! {
    static SOCKETS: RefCell<Vec<Weak<Socket>>> = const { RefCell::new(Vec::new()) };
}

pub(super) fn register(socket: &Rc<Socket>) {
    SOCKETS.with_borrow_mut(|sockets| {
        sockets.retain(|socket| socket.strong_count() > 0);
        sockets.push(Rc::downgrade(socket));
    });
}

pub fn close_for_world_reentry() {
    SOCKETS.with_borrow_mut(|sockets| {
        for socket in sockets.drain(..).filter_map(|socket| socket.upgrade()) {
            let mut inbox = socket.inbox.borrow_mut();
            inbox.closed = true;
            inbox.buf.clear();
            inbox.wake();
            drop(inbox);
            let _ = socket.ws.close();
        }
    });
}
