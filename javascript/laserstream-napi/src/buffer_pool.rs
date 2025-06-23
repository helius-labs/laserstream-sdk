use bytes::BytesMut;
use parking_lot::Mutex;
use std::collections::VecDeque;

const SMALL_BUFFER_SIZE: usize = 64 * 1024;      // 64KB
const MEDIUM_BUFFER_SIZE: usize = 1024 * 1024;   // 1MB
const LARGE_BUFFER_SIZE: usize = 100 * 1024 * 1024; // 100MB

const POOL_SIZE: usize = 100;

pub struct BufferPool {
    small_buffers: Mutex<VecDeque<BytesMut>>,
    medium_buffers: Mutex<VecDeque<BytesMut>>,
    large_buffers: Mutex<VecDeque<BytesMut>>,
}

impl BufferPool {
    pub fn new() -> Self {
        Self {
            small_buffers: Mutex::new(VecDeque::with_capacity(POOL_SIZE)),
            medium_buffers: Mutex::new(VecDeque::with_capacity(POOL_SIZE)),
            large_buffers: Mutex::new(VecDeque::with_capacity(POOL_SIZE)),
        }
    }

    pub fn get_buffer(&self, size: usize) -> BytesMut {
        match size {
            s if s <= SMALL_BUFFER_SIZE => {
                self.get_or_create_buffer(&self.small_buffers, SMALL_BUFFER_SIZE)
            }
            s if s <= MEDIUM_BUFFER_SIZE => {
                self.get_or_create_buffer(&self.medium_buffers, MEDIUM_BUFFER_SIZE)
            }
            _ => {
                self.get_or_create_buffer(&self.large_buffers, LARGE_BUFFER_SIZE)
            }
        }
    }

    pub fn return_buffer(&self, mut buffer: BytesMut) {
        buffer.clear();
        
        let capacity = buffer.capacity();
        
        match capacity {
            SMALL_BUFFER_SIZE => {
                let mut pool = self.small_buffers.lock();
                if pool.len() < POOL_SIZE {
                    pool.push_back(buffer);
                }
            }
            MEDIUM_BUFFER_SIZE => {
                let mut pool = self.medium_buffers.lock();
                if pool.len() < POOL_SIZE {
                    pool.push_back(buffer);
                }
            }
            LARGE_BUFFER_SIZE => {
                let mut pool = self.large_buffers.lock();
                if pool.len() < POOL_SIZE {
                    pool.push_back(buffer);
                }
            }
            _ => {
                // Non-standard size, just drop it
            }
        }
    }

    fn get_or_create_buffer(
        &self,
        pool: &Mutex<VecDeque<BytesMut>>,
        size: usize,
    ) -> BytesMut {
        let mut pool_guard = pool.lock();
        
        if let Some(buffer) = pool_guard.pop_front() {
            buffer
        } else {
            BytesMut::with_capacity(size)
        }
    }
}