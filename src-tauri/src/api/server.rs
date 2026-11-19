use std::io::ErrorKind;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tiny_http::Server;

#[derive(Default)]
pub struct Api {
    server: Mutex<Option<RunningServer>>,
}

impl Api {
    pub(super) fn set_enabled_with(
        &self,
        enabled: bool,
        start: impl FnOnce() -> Result<RunningServer, String>,
    ) -> Result<(), String> {
        let mut server = self
            .server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if enabled && server.is_none() {
            *server = Some(start()?);
        } else if !enabled {
            if let Some(running) = server.take() {
                running.shutdown();
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let mut server = self
            .server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(running) = server.take() {
            running.shutdown();
        }
    }
}

pub(super) struct RunningServer {
    pub(super) server: Arc<Server>,
    pub(super) thread: JoinHandle<()>,
}

impl RunningServer {
    fn shutdown(self) {
        self.server.unblock();
        let _ = self.thread.join();
    }
}

pub(super) fn bind(address: &str) -> Result<Arc<Server>, String> {
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match Server::http(address) {
            Ok(server) => return Ok(Arc::new(server)),
            Err(error) => {
                if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
                    error.kind() == ErrorKind::AddrInUse && Instant::now() < deadline
                }) {
                    thread::sleep(Duration::from_millis(10));
                } else {
                    return Err(error.to_string());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use tiny_http::Response;

    fn test_server(port: u16) -> Result<RunningServer, String> {
        let server = bind(&format!("127.0.0.1:{port}"))?;
        let listening = server.clone();
        let thread = thread::spawn(move || {
            for request in listening.incoming_requests() {
                let _ = request.respond(Response::from_string("ready"));
            }
        });
        Ok(RunningServer { server, thread })
    }

    fn reserve(address: SocketAddr) -> TcpListener {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match TcpListener::bind(address) {
                Ok(listener) => return listener,
                Err(error) if error.kind() == ErrorKind::AddrInUse && Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("could not reserve {address}: {error}"),
            }
        }
    }

    #[test]
    fn server_can_be_enabled_disabled_and_enabled_again() {
        let api = Api::default();
        let first = test_server(0).unwrap();
        let address = first.server.server_addr().to_ip().unwrap();
        api.set_enabled_with(true, || Ok(first)).unwrap();
        assert!(TcpStream::connect(address).is_ok());
        api.set_enabled_with(true, || panic!("already running"))
            .unwrap();
        api.set_enabled_with(false, || panic!("not starting"))
            .unwrap();
        api.set_enabled_with(true, || test_server(address.port()))
            .unwrap();
        api.set_enabled_with(false, || panic!("not starting"))
            .unwrap();
        let occupied = reserve(address);
        assert!(
            api.set_enabled_with(true, || test_server(address.port()))
                .is_err()
        );
        drop(occupied);
        api.set_enabled_with(true, || test_server(address.port()))
            .unwrap();
        assert!(TcpStream::connect(address).is_ok());
        api.shutdown();
        drop(reserve(address));
    }

    #[test]
    fn a_request_can_stop_the_server_and_still_receive_a_reply() {
        let api = Arc::new(Api::default());
        let server = bind("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let listening = server.clone();
        let handle = api.clone();
        let thread = thread::spawn(move || {
            for request in listening.incoming_requests() {
                let api = handle.clone();
                thread::spawn(move || {
                    api.shutdown();
                    let _ = request.respond(Response::from_string("stopped"));
                });
            }
        });
        api.set_enabled_with(true, || Ok(RunningServer { server, thread }))
            .unwrap();

        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client
            .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).unwrap();
        assert!(reply.contains("stopped"), "{reply}");
        drop(reserve(address));
    }
}
